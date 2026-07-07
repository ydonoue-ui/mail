import { createClient } from "https://esm.sh/@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_KEY } from "../config/keys.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
