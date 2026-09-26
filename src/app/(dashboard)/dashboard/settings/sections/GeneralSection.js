"use client";

import PropTypes from "prop-types";
import { useState } from "react";
import { useTheme } from "@/shared/hooks/useTheme";
import SectionCard from "@/shared/components/SectionCard";
import SettingRow from "@/shared/components/SettingRow";
import SegmentedControl from "@/shared/components/SegmentedControl";
import Button from "@/shared/components/Button";
import LanguageSwitcher from "@/shared/components/LanguageSwitcher";
import { LOCALE_NAMES } from "@/i18n/config";

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: "light_mode" },
  { value: "dark", label: "Dark", icon: "dark_mode" },
  { value: "system", label: "System", icon: "contrast" },
];

/**
 * General section: theme segmented control and display language switcher.
 */
export default function GeneralSection({ locale = "en", onLocaleChange }) {
  const { theme, setTheme } = useTheme();
  const [langOpen, setLangOpen] = useState(false);

  return (
    <div id="general" className="scroll-mt-24 space-y-4">
      <SectionCard icon="tune" title="General" subtitle="Look, language and where you land." />
      <div className="rounded-2xl border border-line bg-panel p-5 shadow-card divide-y divide-line">
        <SettingRow
          label="Theme"
          description="Dark, light, or follow your system."
          settingKey="theme"
          control={
            <SegmentedControl
              options={THEME_OPTIONS}
              value={theme}
              onChange={setTheme}
              aria-label="Theme preference"
            />
          }
        />
        <SettingRow
          label="Language"
          description="Dashboard language."
          settingKey="language"
          control={
            <div className="flex items-center gap-2">
              <Button variant="secondary" icon="language" onClick={() => setLangOpen(true)}>
                {LOCALE_NAMES[locale] || locale}
              </Button>
              <LanguageSwitcher
                hideTrigger
                isOpen={langOpen}
                onClose={(next) => {
                  setLangOpen(false);
                  if (next) onLocaleChange?.(next);
                }}
              />
            </div>
          }
        />
      </div>
    </div>
  );
}

GeneralSection.propTypes = {
  locale: PropTypes.string,
  onLocaleChange: PropTypes.func,
};
