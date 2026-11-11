# Giving someone partner (affiliate) access

The partner program is **closed** by default (ADR-021). People who aren't partners see no partner page, menu link or Profile card. There are two ways to let someone in:

- **Invite one email**: the usual way while the program is closed.
- **Open the program**: anyone signed in can join.

Existing partners keep their dashboard and keep earning in both cases.

## Before you start (one time)

```bash
gcloud auth application-default login   # admin script uses Application Default Credentials
cd functions && npm install
```

Run every command below from `functions/`. `npm run affiliates` builds first, then runs `scripts/affiliate-admin.js` against production (`kids-routine-coach-app`).

## Invite a new partner

1. **Add their email to the allowlist:**

   ```bash
   npm run affiliates -- invite dana@example.com
   ```

   This writes `affiliate_invites/dana@example.com` with `{ allowed: true }`. The email is lowercased. The invite isn't tied to an account, so it works for someone who has no account yet.

2. **Send them the link:** `https://kidocoach.app/partners`.

3. **They sign in with that exact email:**
   - **Google or Apple:** already verified, so the join form appears right away.
   - **Email and password:** they see a "Verify your email" card. They tap **Send verification email**, open the link in the email, then tap **I verified**, and the join form appears.

   The verification step is required. Without it, anyone could sign up with the invited address and take the spot.

4. **They fill in the join form:** link code, name, payout method (Wise or PayPal) and payout email, then accept the partner terms. `createAffiliateAccount` creates an active partner on the default terms (15%, 12 months).

5. **Check it worked:**

   ```bash
   npm run affiliates -- list      # the new code should appear with its owner
   ```

Once signed in, invited people see **Become a partner** in the Home menu and a partner card on Profile. Partners see **Partner dashboard** in the menu, and `/partners` (and `/profile`) shows their dashboard. If they open the link signed out, they only see "Sign in to continue".

## Other commands

```bash
npm run affiliates -- invites                    # list invited emails
npm run affiliates -- uninvite dana@example.com  # stop an invite that hasn't joined yet
npm run affiliates -- program open               # public: anyone signed in can join
npm run affiliates -- program closed             # back to invite-only
npm run affiliates -- set-status <code> disabled # pause an existing partner
```

- `uninvite` and `program closed` never remove an existing partner. To stop a partner, use `set-status <code> disabled`.
- Partners can have their custom rate, recurring months or coupon changed with `update` (see `website/README.md` > Affiliates).

## Troubleshooting

| They see | Cause | Fix |
|---|---|---|
| `/partners` sends them to Profile, or no menu item | Signed in with a different email, or not invited | Check `npm run affiliates -- invites`; they must sign in with that exact email |
| "Verify your email" never goes away | They didn't open the email link, or they tapped **I verified** too early | Open the link, then tap **I verified** again (it refreshes the sign-in) |
| "Partner sign-up isn't available" | The invite was removed, or `allowed` isn't `true` | Run `invite` again |
| "You already have a partner account" | That account already owns a code (one per account) | Use the existing dashboard |
