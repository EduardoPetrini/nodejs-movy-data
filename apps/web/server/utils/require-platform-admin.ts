import { createError, type H3Event } from 'h3';
import { useMetaSql } from '../runs';
import { configuredPlatformAdmins, platformAdminIds } from './platform-admin';

/** Whether this request's user operates the platform. Read from the database, never the session. */
export async function isPlatformAdminRequest(event: H3Event): Promise<boolean> {
  const user = event.context.user as { id: string };
  return (await platformAdminIds(useMetaSql(), [user.id], configuredPlatformAdmins())).has(user.id);
}

/** 403 unless the user operates the platform. Use after the org check, never instead of it. */
export async function requirePlatformAdmin(event: H3Event): Promise<void> {
  if (!(await isPlatformAdminRequest(event))) {
    throw createError({ statusCode: 403, statusMessage: "Only the platform's operators can start runners." });
  }
}
