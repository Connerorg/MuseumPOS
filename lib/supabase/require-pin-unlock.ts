import "server-only";
import { createServiceSupabase } from "@/lib/supabase/server";

export async function hasActivePinUnlock(employeeId: string): Promise<boolean> {
  try {
    const { data, error } = await createServiceSupabase().rpc("require_employee_pin_unlock", {
      p_employee_id: employeeId,
    });
    return !error && data === true;
  } catch {
    return false;
  }
}
