import axios from "axios";

import type { RegisterInput } from "@/lib/validations/register";

export async function register(data: RegisterInput) {
  return axios.post("/api/auth/register", data);
}