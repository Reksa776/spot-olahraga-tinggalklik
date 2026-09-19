import { z } from "zod";

/**
 * The registration contract.
 *
 * The optional `referralCode` field was removed with the retail affiliate system. The ticketing
 * PIC attribution is recorded per event order (`PICAttribution`) and is derived from a PIC link or
 * code at checkout, so it has no business being collected at signup.
 */
export const registerSchema = z
  .object({
    name: z.string().min(2, "Nama minimal 2 karakter"),

    email: z
      .string()
      .email("Email tidak valid")
      .optional()
      .or(z.literal("")),

    phone: z
      .string()
      .optional()
      .or(z.literal("")),

    password: z
      .string()
      .min(8, "Password minimal 8 karakter")
      .regex(/[A-Z]/, "Password harus mengandung minimal 1 huruf besar")
      .regex(/[a-z]/, "Password harus mengandung minimal 1 huruf kecil")
      .regex(/[0-9]/, "Password harus mengandung minimal 1 angka"),

    confirmPassword: z
      .string()
      .min(8, "Konfirmasi password wajib diisi"),
  })
  .refine(
    (data) => data.password === data.confirmPassword,
    {
      message: "Password tidak sama",
      path: ["confirmPassword"],
    }
  )
  .refine(
    (data) => data.email || data.phone,
    {
      message: "Email atau nomor HP wajib diisi",
      path: ["email"],
    }
  );

export type RegisterInput = z.infer<typeof registerSchema>;
