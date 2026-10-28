import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(url, anonKey);

/** The same URL and key the client was created with, for the few requests that must be plain `fetch` calls. */
export const apiConfig = { url, anonKey };
