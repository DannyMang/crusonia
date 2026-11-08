// Which company logos public pages (the landing, /pricing) may show. HubSpot and Clerk require written approval before their
// logos appear on another website (web/src/assets/logos/LOGOS.md), so until the owner has it, public pages show those companies'
// plain names. Logos inside the signed-in app stay. Once both approve, flip this one constant. The owner chose to show Claude's.
export const SHOW_APPROVAL_LOGOS_ON_PUBLIC_PAGES = false;

const NEEDS_APPROVAL = ["hubspot", "clerk"];

/** `name`: a BrandName (components/BrandLogo.tsx). */
export const publicLogoAllowed = (name: string, approved = SHOW_APPROVAL_LOGOS_ON_PUBLIC_PAGES) => approved || !NEEDS_APPROVAL.includes(name);
