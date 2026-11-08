# Logos

Each company's own mark, as published, in its own colours. The files are byte-for-byte what the source serves:
never recolour, redraw, crop or stretch one. The app draws them with `<img>` through `BrandLogo`
(`web/src/components/BrandLogo.tsx`), which keeps the aspect ratio and adds no effects. All are trademarks of their
owners, used only to say which service an integration or agent button connects to, never to suggest an endorsement,
and always smaller than Crusonia's own name.

Sources were tried in this order: the company's brand or press-kit page, then Simple Icons (CC0), then the logo on
the company's own website. Every file here came from the first or the third: none needed Simple Icons, and several
Simple Icons colours are out of date (HubSpot, Stripe, Cursor, GitHub).

All accessed 2026-11-07.

| File | Mark | Source | Usage terms | Clear space and size |
| --- | --- | --- | --- | --- |
| `hubspot.svg` | HubSpot sprocket (2025), #FF4800 | Embedded on [HubSpot trademark usage guidelines](https://legal.hubspot.com/tm-usage-guidelines), identical on the [technology partner branding guidelines](https://www.hubspot.com/partners/technology/branding-guidelines) | Placing HubSpot logos on a website needs HubSpot's **written permission**; partners submit a mockup for approval (7-10 business days). No recolouring, no old versions (the #FF7A59 sprocket is an old version), no words directly around the logo | Not public (shared after approval) |
| `notion.svg` | Notion block (cube), black and white | [Notion media kit](https://notion.notion.site/Media-Kit-205535b1d9c4440497a3d7a2ac096286), `NotionLogoFiles.zip` › `notion-logo-block-main.svg` | "Works with Notion" wording is allowed. For integrations Notion points to its "Made for Notion" badge and says **do not use the standalone Notion logo**; permitted uses carry "Notion and the Notion logo are trademarks of Notion Labs, Inc., and are used here with permission." | None for the cube (badge: 48px minimum) |
| `stripe.svg` | Stripe stylized mark, #533AFD | [Stripe marks usage terms](https://stripe.com/legal/marks), [asset](https://images.stripeassets.com/fzn2n1nzq965/2phuvRabuaCNWJGPHi7EFY/c74b44260751b74905cf417e5886d757/parallelogram.svg) (same as stripe.com's favicon; the [logo kit](https://stripe.com/newsroom/information) has the wordmark only) | Allowed to describe your service truthfully, only where it relates to Stripe, not altered, not more prominent than your own marks, no endorsement, no ™/® | Not stated |
| `clerk.svg` | Clerk symbol, #6C47FF and #BAB1FF | [Clerk brand assets](https://clerk.com/brand-assets), [asset](https://clerk.com/v2/downloads/symbol-primary.svg) | Downloads offered publicly, but Clerk's [website terms](https://clerk.com/legal/website-terms) say use of its marks on another website needs **Clerk's express written consent** | Not stated |
| `cursor.svg` | Cursor 2D cube, light variant, #26251E | [cursor.com/brand](https://cursor.com/brand), `cursor-brand-assets.zip` › `General Logos/Cube/SVG/CUBE_2D_LIGHT.svg` | No licence text; "Refer to us as Cursor. Not Cursor AI or Cursor Code." Referential use, unaltered | Not stated |
| `claude.svg` | Claude spark, Clay #D97757 | [Anthropic press kit](https://www.anthropic.com/press-kit) › `Claude logos/3 Claude Spark/SVG/Claude Spark - Clay.svg` | Anthropic's [trademark guidelines](https://www.anthropic.com/legal/trademark-guidelines): use only as Anthropic permits and **in materials it approves beforehand** (marketing@anthropic.com); no alterations, no endorsement, no ™ | "Reasonable space" on each side; no minimum |
| `codex.svg` | OpenAI Blossom, black (OpenAI publishes no Codex-specific mark) | [openai.com/brand](https://openai.com/brand/), [openai-logos.zip](https://cdn.openai.com/brand/openai-logos.zip) › `OAI_OpenAI-Blossom_Black.svg` | Use only where it relates to OpenAI services, exactly as provided, not more prominent than your own, no endorsement, never as primary branding; revocable | Clear space (about 0.54× the Blossom's width per side) is built into the file, so `BrandLogo` scales it up to keep the glyph the same size as the others |
| `google.svg` | Google "G", four colours | Copied from the "Generate HTML Button Element" tool on [Sign in with Google branding guidelines](https://developers.google.com/identity/branding-guidelines); same paths as the G Google's sign-in SDK renders today | Only inside a sign-in button with text ("Continue with Google"), on white, not resized relative to the button, never monochrome. The guidelines' text asks for the newer gradient "super G"; Google's downloadable bundle draws that one with HTML inside the SVG and only as a whole button, so it is not used here | 20px G in a 40px button, 12/10/12px padding |
| `github.svg` | GitHub Invertocat, black | [brand.github.com](https://brand.github.com/foundations/logo), [GitHub_Logos.zip](https://brand.github.com/GitHub_Logos.zip) › `GitHub_Invertocat_Black.svg` | Allowed to say a project integrates with GitHub and as a sign-in/social button; not altered (colour or proportions), less prominent than your own, no endorsement | About 1/6 of the mark's width on each side |
| `apify.svg` | Apify symbol, #246DFF, #20A34E, #F86606 | [Apify brand](https://apify.com/resources/brand), [asset](https://apify.com/img/brand/apify-symbol.svg?download=1) | No licence text; the logo manual says always use the master artwork, unedited and undistorted, and the symbol always uses all three colours | 50% of the symbol's height for the full logo; the symbol file has 25% padding built in, which `BrandLogo` keeps |
| `agentmail.png` | AgentMail mark, white on #18181B (256px) | [agentmail.to](https://www.agentmail.to/) favicon (`/favicon.ico`, its 256px PNG frame copied as is); AgentMail has no brand kit or light-background symbol-only SVG | No published guidelines; trademark of AgentMail, Inc., used only to identify the AgentMail integration | Not stated |
| `naive.svg` | Naive "n" tile, #111114 | [usenaive.ai](https://usenaive.ai/) favicon ([asset](https://usenaive.ai/favicon.svg?v=8)); no brand kit (naive.ai is a different company) | No published guidelines; trademark of Naive, used only to identify the Naive integration | Not stated |
| `photon.png` | Photon primary icon (128px) | [photon.codes/brand](https://photon.codes/brand), icons zip › `Photon Icon - Primary - 128w.png` (the zip's SVG carries a hidden leftover raster, so the official PNG export is used) | No licence text; the brand page asks for the name and logo to be used correctly, marks evenly sized with plenty of clear space | "Plenty of clear space"; no numbers |

Not included on purpose: Cloudflare's logo (its [trademark guidelines](https://www.cloudflare.com/trademark/) allow
the word mark only; logos need written permission) and Neon's (named in text only).

**Needs the owner's call:** HubSpot, Anthropic (Claude) and Clerk ask for permission before their logos are shown on
another website, and Notion asks integrations to use its "Made for Notion" badge instead of the cube. Until that is
settled, the marks above are the correct official files, but showing them in public is the owner's decision. Public pages
show the first three as plain names: `SHOW_APPROVAL_LOGOS_ON_PUBLIC_PAGES` in `web/src/lib/public-logos.ts` is the one
switch, off until the approvals are in. Logos inside the signed-in app stay.
