import { z } from 'zod';

// Shape of an enquiry posted by the website form. Unknown fields are rejected so
// integration mistakes surface immediately instead of being silently dropped.
export const LeadSchema = z.strictObject({
  name: z.string().trim().min(1, 'Name is required').max(120),
  email: z.string().trim().toLowerCase().pipe(z.email('Invalid email address').max(254)),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{7,20}$/, 'Invalid phone number')
    .optional(),
  message: z.string().trim().max(2000).optional(),
  source: z.string().trim().min(1).max(50).default('website'),
});

export type Lead = z.infer<typeof LeadSchema>;

export interface FieldError {
  field: string;
  message: string;
}

export type ParseLeadResult = { ok: true; lead: Lead } | { ok: false; errors: FieldError[] };

export function parseLead(input: unknown): ParseLeadResult {
  const result = LeadSchema.safeParse(input);
  if (result.success) return { ok: true, lead: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => ({
      field: issue.path.join('.') || '(body)',
      message: issue.message,
    })),
  };
}
