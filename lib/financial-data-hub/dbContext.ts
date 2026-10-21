/**
 * Document2 (4) WP-G -- which database client the Financial Data Hub repositories use for the current piece of work.
 *
 * A request from a signed-in browser uses the ordinary cookie-bound, row-level-security client (`createClient`). The background
 * bank-import worker can also be driven by the scheduled backstop, which has NO user session at all: there the same repositories
 * and services must run under the service role. `runWithFdhServiceClient` installs that client for the duration of one slice
 * (AsyncLocalStorage, so it follows the awaits and cannot leak into another request), and `fdhDbClient` hands out whichever applies.
 *
 * SAFETY. Nothing changes for a normal request: with no context installed this is exactly `createClient()`. Every FDH repository
 * method and service query already filters on `user_id` explicitly (repositories/base.ts: "defence in depth ... a query that
 * somehow ran with the service-role client would still be scoped"), and a slice is only ever started for a job whose owner was
 * resolved from the job row itself. This file never imports the service-role client: the worker installs it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createClient } from '@/lib/supabase/server';

type DbClient = Awaited<ReturnType<typeof createClient>>;

const store = new AsyncLocalStorage<{ client: DbClient }>();

/** Runs `fn` with every FDH repository / service read and write going through `client` (a service-role client). */
export function runWithFdhServiceClient<T>(client: unknown, fn: () => Promise<T>): Promise<T> {
  return store.run({ client: client as DbClient }, fn);
}

/** The client for the current piece of work: the installed service client inside a background slice, otherwise the request's own. */
export async function fdhDbClient(): Promise<DbClient> {
  return store.getStore()?.client ?? createClient();
}

/** True inside a background slice (used by tests and guards). */
export function isInFdhServiceContext(): boolean {
  return store.getStore() !== undefined;
}
