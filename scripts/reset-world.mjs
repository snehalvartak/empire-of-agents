/**
 * Manual world reset script.
 *
 * Archives the live session (marks it ended in the sessions table) so its
 * world stays replayable. Run with: npm run reset-world
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

function env(key) {
  const match = readFileSync(new URL('../.env', import.meta.url), 'utf8').match(
    new RegExp(`^${key}=(.*)$`, 'm')
  );
  if (!match) throw new Error(`Missing ${key} in .env`);
  return match[1].trim().replace(/^["']|["']$/g, '');
}

const supabase = createClient(env('VITE_SUPABASE_URL'), env('VITE_SUPABASE_ANON_KEY'));
const none = '00000000-0000-0000-0000-000000000000';

const { data: live, error: liveErr } = await supabase
  .from('sessions')
  .select('id, seq, title')
  .eq('status', 'live')
  .order('started_at', { ascending: false })
  .limit(1)
  .maybeSingle();

if (liveErr) {
  console.error('Could not find the live session:', liveErr.message);
  process.exit(1);
}
if (!live) {
  console.log('No live session to archive. Nothing to do.');
  process.exit(0);
}

const { error } = await supabase
  .from('sessions')
  .update({ status: 'archived', ended_at: new Date().toISOString(), title: live.title || `Session ${live.seq}` })
  .neq('id', none)
  .eq('id', live.id);

if (error) {
  console.error('Reset failed:', error.message);
  process.exit(1);
}

console.log(
  `"${live.title || `Session ${live.seq}`}" is now archived and replayable. The next app load begins a fresh session.`
);
