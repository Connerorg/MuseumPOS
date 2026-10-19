import { createBrowserClient } from "@supabase/ssr";

/** Uses only publishable/anon credentials. Never put service-role credentials here. */
export function createSupabaseBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Public Supabase configuration is missing");
  return createBrowserClient(url, key);
}
