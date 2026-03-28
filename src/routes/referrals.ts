import { Router, Request, Response } from "express";
import { ReferralModel } from "../models/referral";

const router = Router();
const referralModel = new ReferralModel();

// Generate a referral code for a user (idempotent)
router.post("/generate", async (req: Request, res: Response) => {
	const { userId } = req.body;
	if (!userId) return res.status(400).json({ error: "Missing userId" });
	try {
		// Only one code per user
		let referral = await referralModel.findByCode(userId);
		if (!referral) {
			referral = await referralModel.createReferral(userId);
		}
		res.json({ referral_code: referral.referral_code });
	} catch (error) {
		res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
	}
});

// Use a referral code during signup
router.post("/use", async (req: Request, res: Response) => {
	const { userId, referral_code } = req.body;
	if (!userId || !referral_code) return res.status(400).json({ error: "Missing userId or referral_code" });
	try {
		// Validate code
		const ref = await referralModel.findByCode(referral_code);
		if (!ref || ref.user_id === userId) return res.status(400).json({ error: "Invalid or self-referral code" });
		// Prevent double-spend
		if (await referralModel.hasUsedReferral(userId)) return res.status(400).json({ error: "Referral already used" });
		// Create referral record for referee
		await referralModel.createReferral(userId, ref.user_id);
		// Grant rewards (fee-free volume logic placeholder)
		await referralModel.markRewardGranted(ref.id);
		res.json({ message: "Referral applied, rewards granted" });
	} catch (error) {
		res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
	}
});

export default router;
