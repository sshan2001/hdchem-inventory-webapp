import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://begqlkbjseuroxifnljo.supabase.co";
const supabaseKey = "sb_publishable_sueRtmzmDb-vjClVon9AIg_FddPALLC";

export const supabase = createClient(supabaseUrl, supabaseKey);
