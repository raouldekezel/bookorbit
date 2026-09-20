import { randomUUID } from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';

import * as schema from '../src/db/schema';
import { createEpubFixture } from './e2e/reader-state-isolation/reader-state-isolation-fixture-builder';
import {
  authHeader,
  closeReaderStateIsolationE2EContext,
  createLibraryWithFolder,
  createReaderStateIsolationE2EContext,
  createUserAndLogin,
  locateBookByAbsolutePath,
  triggerAndWaitForLibraryScan,
  type ReaderStateIsolationE2EContext,
} from './e2e/reader-state-isolation/reader-state-isolation-harness';

type KoboDevice = { id: number; token: string };

function entitlementIds(entries: unknown[]): string[] {
  return entries.flatMap((entry) => {
    const value = entry as Record<string, Record<string, Record<string, string>>>;
    const bookEntitlement = value.NewEntitlement?.BookEntitlement ?? value.ChangedProductMetadata?.BookEntitlement;
    return bookEntitlement?.Id ? [bookEntitlement.Id] : [];
  });
}

function removedEntitlementIds(entries: unknown[]): string[] {
  return entries.flatMap((entry) => {
    const value = entry as Record<string, Record<string, Record<string, string>>>;
    const bookEntitlement = value.ChangedEntitlement?.BookEntitlement;
    return bookEntitlement?.Id ? [bookEntitlement.Id] : [];
  });
}

describe('FEAT-01 Kobo device removal and synced collections (e2e)', { timeout: 180_000 }, () => {
  let ctx!: ReaderStateIsolationE2EContext;
  let userId!: number;
  let bookId!: number;
  let otherBookId!: number;
  let entitlementId!: string;
  let syncedCollectionA!: number;
  let syncedCollectionB!: number;
  let unsyncedCollection!: number;
  let foreignCollection!: number;
  let device!: KoboDevice;
  let secondDevice!: KoboDevice;

  async function sync(target: KoboDevice): Promise<unknown[]> {
    const delivered: unknown[] = [];
    let syncToken: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/kobo/${target.token}/v1/library/sync`,
        headers: syncToken ? { 'x-kobo-synctoken': syncToken } : undefined,
      });
      expect(response.statusCode).toBe(200);
      delivered.push(...(response.json() as unknown[]));
      if (response.headers['x-kobo-sync'] !== 'continue') return delivered;
      syncToken = response.headers['x-kobo-synctoken'] as string;
    }
    throw new Error(`Kobo device ${target.id} did not finish syncing within ten pages`);
  }

  async function createDevice(name: string): Promise<KoboDevice> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/kobo/devices',
      headers: authHeader(ctx.adminToken),
      payload: { name },
    });
    expect([200, 201]).toContain(response.statusCode);
    return response.json() as KoboDevice;
  }

  async function createCollection(name: string, syncToKobo: boolean): Promise<number> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: authHeader(ctx.adminToken),
      payload: { name: `${name} ${randomUUID().slice(0, 8)}`, icon: 'book', syncToKobo },
    });
    expect([200, 201]).toContain(response.statusCode);
    return (response.json() as { id: number }).id;
  }

  async function addToCollection(collectionId: number, bookIds: number[]): Promise<void> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/collections/${collectionId}/books`,
      headers: authHeader(ctx.adminToken),
      payload: { bookIds },
    });
    expect([200, 201]).toContain(response.statusCode);
  }

  async function setPreference(enabled: boolean): Promise<Record<string, unknown>> {
    const response = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/kobo/settings',
      headers: authHeader(ctx.adminToken),
      payload: { removeFromSyncedCollectionsOnDeviceDelete: enabled },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as Record<string, unknown>;
  }

  async function deleteOnDevice(target: KoboDevice): Promise<void> {
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/kobo/${target.token}/v1/library/${entitlementId}`,
    });
    expect(response.statusCode).toBe(200);
  }

  async function collectionsHolding(targetBookId: number): Promise<number[]> {
    const rows = await ctx.db
      .select({ collectionId: schema.collectionBooks.collectionId })
      .from(schema.collectionBooks)
      .where(
        and(
          eq(schema.collectionBooks.bookId, targetBookId),
          inArray(schema.collectionBooks.collectionId, [syncedCollectionA, syncedCollectionB, unsyncedCollection, foreignCollection]),
        ),
      );
    return rows.map((row) => row.collectionId).sort((a, b) => a - b);
  }

  async function readingData(): Promise<{ koboState: unknown[]; statuses: unknown[] }> {
    const state = await ctx.app.inject({ method: 'GET', url: `/api/v1/kobo/${secondDevice.token}/v1/library/${entitlementId}/state` });
    expect(state.statusCode).toBe(200);
    const statuses = await ctx.db
      .select()
      .from(schema.userBookStatus)
      .where(and(eq(schema.userBookStatus.userId, userId), eq(schema.userBookStatus.bookId, bookId)));
    return { koboState: state.json() as unknown[], statuses };
  }

  beforeAll(async () => {
    ctx = await createReaderStateIsolationE2EContext();
    const library = await createLibraryWithFolder(ctx, { name: `kobo-device-removal-${randomUUID()}` });
    const paths = await Promise.all(
      [1, 2].map((index) =>
        createEpubFixture(library.folderPath, `kobo-device-removal-${index}.epub`, {
          title: `Kobo Device Removal ${index}`,
          uid: `urn:uuid:${randomUUID()}`,
        }),
      ),
    );
    await triggerAndWaitForLibraryScan(ctx, library.libraryId);
    [bookId, otherBookId] = (await Promise.all(paths.map((path) => locateBookByAbsolutePath(ctx, path)))).map((book) => book.bookId) as [
      number,
      number,
    ];

    const [user] = await ctx.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, 'reader-state-e2e-admin'));
    userId = user!.id;

    syncedCollectionA = await createCollection('Kobo delivery A', true);
    syncedCollectionB = await createCollection('Kobo delivery B', true);
    unsyncedCollection = await createCollection('Favourites', false);
    await addToCollection(syncedCollectionA, [bookId, otherBookId]);
    await addToCollection(syncedCollectionB, [bookId]);
    await addToCollection(unsyncedCollection, [bookId]);

    const otherUser = await createUserAndLogin(ctx);
    const [foreign] = await ctx.db
      .insert(schema.collections)
      .values({ userId: otherUser.userId, name: `Foreign delivery ${randomUUID().slice(0, 8)}`, isPublic: true, syncToKobo: true })
      .returning({ id: schema.collections.id });
    foreignCollection = foreign!.id;
    await ctx.db.insert(schema.collectionBooks).values({ collectionId: foreignCollection, bookId });

    device = await createDevice('Kobo removal A');
    secondDevice = await createDevice('Kobo removal B');
    await sync(device);
    await sync(secondDevice);

    const [identity] = await ctx.db
      .select({ entitlementId: schema.koboBookEntitlements.entitlementId })
      .from(schema.koboBookEntitlements)
      .where(and(eq(schema.koboBookEntitlements.userId, userId), eq(schema.koboBookEntitlements.bookId, bookId)));
    entitlementId = identity!.entitlementId;
  }, 180_000);

  afterAll(async () => {
    if (ctx) await closeReaderStateIsolationE2EContext(ctx);
  });

  it('reports the preference as off by default and round-trips it through the settings API', async () => {
    const initial = await ctx.app.inject({ method: 'GET', url: '/api/v1/kobo/settings', headers: authHeader(ctx.adminToken) });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ removeFromSyncedCollectionsOnDeviceDelete: false });

    expect(await setPreference(true)).toMatchObject({ removeFromSyncedCollectionsOnDeviceDelete: true });
    const enabled = await ctx.app.inject({ method: 'GET', url: '/api/v1/kobo/settings', headers: authHeader(ctx.adminToken) });
    expect(enabled.json()).toMatchObject({ removeFromSyncedCollectionsOnDeviceDelete: true });

    const unrelated = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/kobo/settings',
      headers: authHeader(ctx.adminToken),
      payload: { storeSync: false },
    });
    expect(unrelated.json()).toMatchObject({ removeFromSyncedCollectionsOnDeviceDelete: true });

    expect(await setPreference(false)).toMatchObject({ removeFromSyncedCollectionsOnDeviceDelete: false });
  });

  it('keeps collection membership and offers the book again when the preference is off', async () => {
    await deleteOnDevice(device);

    expect(await collectionsHolding(bookId)).toEqual(
      [syncedCollectionA, syncedCollectionB, unsyncedCollection, foreignCollection].sort((a, b) => a - b),
    );
    expect(entitlementIds(await sync(device))).toContain(entitlementId);
  });

  it('removes the book from every owned synced collection only, and keeps the book and reading data', async () => {
    const readingState = {
      EntitlementId: entitlementId,
      LastModified: '2026-12-01T00:00:00.000Z',
      PriorityTimestamp: '2026-12-01T00:00:00.000Z',
      CurrentBookmark: { LastModified: '2026-12-01T00:00:00.000Z', ProgressPercent: 42 },
      Statistics: { LastModified: '2026-12-01T00:00:00.000Z', SpentReadingMinutes: 12 },
      StatusInfo: { LastModified: '2026-12-01T00:00:00.000Z', Status: 'Reading' },
    };
    const putState = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/kobo/${device.token}/v1/library/${entitlementId}/state`,
      payload: { ReadingStates: [readingState] },
    });
    expect(putState.statusCode).toBe(200);
    await sync(device);
    await sync(secondDevice);

    const readingDataBefore = await readingData();
    expect(readingDataBefore.koboState).toHaveLength(1);
    expect(readingDataBefore.statuses).toHaveLength(1);

    await setPreference(true);
    await deleteOnDevice(device);

    expect(await collectionsHolding(bookId)).toEqual([unsyncedCollection, foreignCollection].sort((a, b) => a - b));
    expect(await collectionsHolding(otherBookId)).toEqual([syncedCollectionA]);

    const [book] = await ctx.db.select({ id: schema.books.id, status: schema.books.status }).from(schema.books).where(eq(schema.books.id, bookId));
    expect(book).toMatchObject({ id: bookId, status: 'present' });
    expect(await readingData()).toEqual(readingDataBefore);
  });

  it('does not deliver the book again and withdraws it from the other device', async () => {
    const afterRemoval = await sync(device);
    expect(entitlementIds(afterRemoval)).not.toContain(entitlementId);
    expect(removedEntitlementIds(afterRemoval)).not.toContain(entitlementId);

    expect(removedEntitlementIds(await sync(secondDevice))).toContain(entitlementId);
  });

  it('accepts a repeated device delete without touching anything else', async () => {
    await deleteOnDevice(device);
    await deleteOnDevice(device);

    expect(await collectionsHolding(bookId)).toEqual([unsyncedCollection, foreignCollection].sort((a, b) => a - b));
    expect(await collectionsHolding(otherBookId)).toEqual([syncedCollectionA]);
  });

  it('delivers the book again once it is added back to a synced collection', async () => {
    await addToCollection(syncedCollectionA, [bookId]);

    expect(entitlementIds(await sync(device))).toContain(entitlementId);
  });
});
