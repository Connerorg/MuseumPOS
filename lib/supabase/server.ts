import "server-only";
import { createClient } from "@supabase/supabase-js";
/** Elevated server-only client. Never import into a Client Component. */
export function createServiceSupabase() {
 const url=process.env.NEXT_PUBLIC_SUPABASE_URL; const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 if(!url||!key) throw new Error("Supabase server configuration is missing");
 return createClient(url,key,{auth:{autoRefreshToken:false,persistSession:false}});
}
