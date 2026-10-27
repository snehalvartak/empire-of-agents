import { sim } from './simulation';
import { supabase } from '@/lib/supabase';

/**
 * Wipes the live world state by archiving the current session: villagers,
 * structures, stockpile and chronicle are preserved and replayable. The next
 * app load (or sim.startSession) begins a fresh session.
 */
export async function resetWorld(): Promise<void> {
  await sim.resetWorld();
}

const VERSION_ROW = 'world_state';
const CURRENT_VERSION = 'v3';

/**
 * Runs on app load: if the deployed version differs from the stamped one,
 * archives the live session (data kept, replayable) and stamps the new
 * version, so the next visitor starts a fresh session.
 */
export async function resetWorldOnDeploy(): Promise<void> {
  const { data } = await supabase
    .from('settings')
    .select('deploy_version')
    .eq('id', VERSION_ROW)
    .maybeSingle();

  if (data?.deploy_version === CURRENT_VERSION) return;

  await resetWorld();
  await supabase
    .from('settings')
    .upsert({ id: VERSION_ROW, deploy_version: CURRENT_VERSION, updated_at: new Date().toISOString() });
}
