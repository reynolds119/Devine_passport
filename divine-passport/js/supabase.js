import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error("Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to use Supabase.");
}

export const supabase = createClient(supabaseUrl, supabasePublishableKey);

export async function invokeFunction(name, body = {}) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let message = error.message;
    try {
      const response = error.context;
      if (response instanceof Response) message = (await response.clone().json()).error || message;
    } catch {}
    throw new Error(message);
  }
  return data;
}