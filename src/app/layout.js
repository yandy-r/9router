import { Bricolage_Grotesque, Geist, Geist_Mono } from "next/font/google";
import { GoogleAnalytics } from "@next/third-parties/google";
import "material-symbols/outlined.css";
import "./globals.css";
import { ThemeProvider } from "@/shared/components/ThemeProvider";
import "@/lib/network/initOutboundProxy"; // Auto-initialize outbound proxy env
import "@/shared/services/bootstrap"; // Auto-run initializeApp (watchdog, auto-resume tunnel)
import { initConsoleLogCapture } from "@/lib/consoleLogBuffer";
import { RuntimeI18nProvider } from "@/i18n/RuntimeI18nProvider";
import { LOCALES, LOCALE_COOKIE, RTL_LOCALES } from "@/i18n/config";

// Hook console immediately at module load time (server-side only, runs once)
initConsoleLogCapture();

// Signal type system: Bricolage Grotesque (display), Geist (UI), Geist Mono
const bricolage = Bricolage_Grotesque({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-bricolage",
  weight: ["500", "700", "800"],
});

const geist = Geist({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-geist",
  weight: ["400", "500", "600"],
});

const geistMono = Geist_Mono({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-geist-mono",
  weight: ["400", "500", "600"],
});

export const metadata = {
  title: "9Router - AI Infrastructure Management",
  description:
    "One endpoint for all your AI providers. Manage keys, monitor usage, and scale effortlessly.",
  icons: {
    icon: "/favicon.svg",
  },
};

export const viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f1ea" },
    { media: "(prefers-color-scheme: dark)", color: "#0d0e12" },
  ],
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      // next/font variables must live on <html>: --signal-font-* is declared on :root
      className={`${bricolage.variable} ${geist.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Apply persisted theme before first paint so a reload does not flash the
            default (dark) theme before the client store hydrates. Mirrors the
            zustand-persist "theme" key and the `dark` class applyTheme() sets. */}
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static no-flash theme script, no user input
          dangerouslySetInnerHTML={{
            __html: `(function(){var r=document.documentElement;try{var s=localStorage.getItem('theme');var t=s?(JSON.parse(s).state||{}).theme:'dark';t=t||'dark';var m=window.matchMedia('(prefers-color-scheme: dark)').matches;if(t==='dark'||(t==='system'&&m)){r.classList.add('dark')}else{r.classList.remove('dark')}}catch(e){r.classList.add('dark')}try{var c=document.cookie.match(/(?:^|; )${LOCALE_COOKIE}=([^;]*)/);var l=c?decodeURIComponent(c[1]):'en';if(l==='zh')l='zh-CN';if(${JSON.stringify(LOCALES)}.indexOf(l)<0)l='en';r.lang=l;if(${JSON.stringify(RTL_LOCALES)}.indexOf(l)>=0)r.dir='rtl'}catch(e){}})();`,
          }}
        />
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static font-loader script, no user input
          dangerouslySetInnerHTML={{
            __html: `var d=document,r=d.documentElement,f=function(){r.classList.add('fonts-loaded')};if(d.fonts&&d.fonts.load){d.fonts.load('24px "Material Symbols Outlined"').then(f).catch(f);setTimeout(f,3000)}else{f()}`,
          }}
        />
      </head>
      <body className="font-sans antialiased">
        <ThemeProvider>
          <RuntimeI18nProvider>{children}</RuntimeI18nProvider>
        </ThemeProvider>
        <GoogleAnalytics gaId={"G-LC959F603F"} />
      </body>
    </html>
  );
}
