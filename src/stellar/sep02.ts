const federationQuerySchema = z.object({
  q: z.string().min(1, "q is required"),
  type: z.enum(["name", "id", "txid", "forward"], {
    error: () => ({ message: "type must be one of: name, id, txid, forward" }),
  }),
});
if (!parsed.success) {
  return res.status(400).json({ detail: parsed.error.issues[0].message });
}
