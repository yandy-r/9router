/**
 * Settings section registry: the single source of truth for the
 * `/dashboard/settings` page shell. Each section declares its id, title,
 * subtitle, icon and rows (key, label, description, keywords, tags). The
 * registry drives rendering, the anchor nav, search, and the command-palette
 * registration (YAN-294 — no palette exists yet, so `toCommandItems` exports
 * the items ready to plug in).
 *
 * Rows are metadata only; interactive controls live in the section components.
 */

/**
 * @typedef {object} SettingsRow
 * @property {string} key Stored settings key (or pseudo-key for actions).
 * @property {string} label Row label shown in the UI.
 * @property {string} [description] Short explainer.
 * @property {string} [keywords] Extra search terms (space-separated).
 * @property {Array<"new"|"env"|"experimental">} [tags] Board tags.
 */

/**
 * @typedef {object} SettingsSection
 * @property {string} id Anchor id.
 * @property {string} title Section title.
 * @property {string} subtitle Section subtitle.
 * @property {string} icon Material Symbols Outlined icon name.
 * @property {string} [statusPill] Optional status pill label.
 * @property {SettingsRow[]} rows Searchable rows in this section.
 */

/** @type {SettingsSection[]} */
export const SETTINGS_SECTIONS = [
  {
    id: "general",
    title: "General",
    subtitle: "Look, language and where you land.",
    icon: "tune",
    rows: [
      {
        key: "theme",
        label: "Theme",
        description: "Dark, light, or follow your system.",
        keywords: "dark light system appearance color mode",
      },
      {
        key: "language",
        label: "Language",
        description: "Dashboard language.",
        keywords: "locale i18n display language",
      },
    ],
  },
  {
    id: "security",
    title: "Security & access",
    subtitle: "Who can reach the dashboard and the API.",
    icon: "shield",
    statusPill: "Protected",
    rows: [
      {
        key: "requireLogin",
        label: "Require login",
        description: "Ask for the dashboard password first.",
        keywords: "login auth password required",
      },
      {
        key: "password",
        label: "Password",
        description: "Change the dashboard password. Replace the default before exposing anything.",
        keywords: "change set update password",
      },
      {
        key: "requireApiKey",
        label: "Require API key",
        description: "Requests without a valid key get a 401. Needed for the tunnel.",
        keywords: "api key auth 401 endpoint",
      },
      {
        key: "tunnelDashboardAccess",
        label: "Dashboard over tunnel",
        description: "Serve this dashboard on the public tunnel URL too.",
        keywords: "tunnel tailscale remote access dashboard",
      },
    ],
  },
  {
    id: "sso",
    title: "Single sign-on",
    subtitle: "Sign in with your identity provider.",
    icon: "lock_open",
    rows: [
      {
        key: "authMode",
        label: "Sign-in method",
        description: "Password only, SSO only, or both.",
        keywords: "auth mode sso password both oidc saml",
      },
      {
        key: "ssoType",
        label: "Protocol",
        description: "OIDC or SAML 2.0.",
        keywords: "protocol oidc saml",
      },
      {
        key: "oidcIssuerUrl",
        label: "Issuer URL",
        description: "OIDC issuer base URL.",
        keywords: "oidc issuer url openid",
      },
      {
        key: "oidcClientId",
        label: "Client ID",
        description: "OIDC client identifier.",
        keywords: "oidc client id",
      },
      {
        key: "oidcClientSecret",
        label: "Client secret",
        description: "Write-only after saving.",
        keywords: "oidc secret write-only",
      },
      {
        key: "oidcScopes",
        label: "Scopes",
        description: "OIDC scopes, space-separated.",
        keywords: "oidc scopes openid profile email",
      },
      {
        key: "oidcLoginLabel",
        label: "Button label",
        description: "OIDC sign-in button text.",
        keywords: "oidc button label",
      },
      {
        key: "samlEntryPoint",
        label: "Single Sign-On Service URL",
        description: "IdP SSO URL.",
        keywords: "saml sso url entry point idp",
      },
      {
        key: "samlIssuer",
        label: "SP Entity ID / Audience",
        description: "Service provider entity id.",
        keywords: "saml issuer entity audience sp",
      },
      {
        key: "samlCert",
        label: "IdP X.509 Certificate",
        description: "IdP signing certificate.",
        keywords: "saml cert certificate x509 pem",
      },
      {
        key: "samlLoginLabel",
        label: "Login button label",
        description: "SAML sign-in button text.",
        keywords: "saml button label",
      },
      {
        key: "samlAttributeEmail",
        label: "Email claim attribute",
        description: "SAML attribute carrying the email.",
        keywords: "saml attribute email claim nameid",
      },
      {
        key: "samlAttributeName",
        label: "Display name claim",
        description: "SAML attribute carrying the display name.",
        keywords: "saml attribute name display claim",
      },
      {
        key: "ssoRedirect",
        label: "Redirect URI / ACS URL",
        description: "Give these to your IdP. Read-only, with copy.",
        keywords: "redirect acs metadata callback url copy",
      },
      {
        key: "ssoTest",
        label: "Test sign-in",
        description: "Verify the OIDC / SAML configuration.",
        keywords: "test sign-in verify connection guides okta entra keycloak aws",
      },
    ],
  },
  {
    id: "pricing",
    title: "Pricing",
    subtitle: "What cost estimates use, in $ per 1M tokens.",
    icon: "savings",
    rows: [
      {
        key: "pricingOverview",
        label: "Pricing overview",
        description: "Model count, provider count, custom overrides.",
        keywords: "pricing models providers custom cost overview",
      },
      {
        key: "pricingEdit",
        label: "Edit pricing",
        description: "Override per-model rates.",
        keywords: "edit pricing modal override rates",
      },
      {
        key: "pricingReset",
        label: "Reset to defaults",
        description: "Restore standard rates.",
        keywords: "reset defaults restore pricing",
      },
    ],
  },
  {
    id: "data",
    title: "Data & backup",
    subtitle: "Everything lives in one SQLite file.",
    icon: "database",
    rows: [
      {
        key: "databasePath",
        label: "Database",
        description: "SQLite file location.",
        keywords: "database sqlite location path size data dir",
      },
      {
        key: "backup",
        label: "Backup",
        description: "Download or import a password-gated backup.",
        keywords: "backup download import export restore password",
      },
    ],
  },
  {
    id: "danger",
    title: "Danger zone",
    subtitle: "End sessions and stop the server.",
    icon: "warning",
    rows: [
      {
        key: "logout",
        label: "Log out",
        description: "End this dashboard session.",
        keywords: "logout sign out session",
      },
      {
        key: "shutdown",
        label: "Shut down 9router",
        description: "Your tools lose their endpoint until you start it again.",
        keywords: "shutdown stop close server power",
      },
    ],
  },
];

/** Anchor nav entries in section order: [{ id, title }]. */
export const SETTINGS_ANCHORS = SETTINGS_SECTIONS.map(({ id, title }) => ({ id, title }));

/**
 * Section anchors in registry order.
 * @returns {Array<{ id: string, title: string }>}
 */
export function sectionAnchors() {
  return SETTINGS_ANCHORS.map((anchor) => ({ ...anchor }));
}

function rowMatches(row, query) {
  const haystack =
    `${row.key} ${row.label} ${row.description ?? ""} ${row.keywords ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/**
 * Filter registry rows by label, description, key and keywords.
 * Empty query returns every section untouched.
 * @param {string} query Search text.
 * @returns {SettingsSection[]} Sections with at least one matching row.
 */
export function filterRows(query) {
  if (!query?.trim()) return SETTINGS_SECTIONS;
  return SETTINGS_SECTIONS.map((section) => ({
    ...section,
    rows: section.rows.filter((row) => rowMatches(row, query)),
  })).filter((section) => section.rows.length > 0);
}

/**
 * Command-palette items for every registry row, ready to register with the
 * YAN-294 palette when it lands.
 * @returns {Array<{ id: string, label: string, hint: string, href: string }>}
 */
export function toCommandItems() {
  return SETTINGS_SECTIONS.flatMap((section) =>
    section.rows.map((row) => ({
      id: `settings:${row.key}`,
      group: "Settings",
      label: `${section.title} — ${row.label}`,
      hint: row.description || "",
      keywords: `${section.title} ${row.label} ${row.description || ""} ${row.keywords || ""}`,
      icon: section.icon || "settings",
      href: `/dashboard/settings#${section.id}`,
      run: { type: "navigate", href: `/dashboard/settings#${section.id}` },
    })),
  );
}
