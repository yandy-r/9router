"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { useTheme } from "@/shared/hooks/useTheme";
import ChangelogModal from "./ChangelogModal";
import { ConfirmDialog } from "./Modal";
import Menu, { MenuItem } from "./Menu";
import IconButton from "./IconButton";

/**
 * Header app menu. Renders the grid trigger via the shared Menu button
 * pattern (roving focus, typeahead, Esc/click-outside close).
 * @param {object} props
 * @param {() => void} props.onLogout
 */
export default function HeaderMenu({ onLogout }) {
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [shutdownOpen, setShutdownOpen] = useState(false);
  const [isShuttingDown, setIsShuttingDown] = useState(false);
  const { toggleTheme, isDark } = useTheme();

  const handleShutdown = async () => {
    setIsShuttingDown(true);
    try {
      await fetch("/api/version/shutdown", { method: "POST" });
    } catch {
      // Expected: the server is shutting down, so the fetch fails.
    }
    setIsShuttingDown(false);
    setShutdownOpen(false);
  };

  return (
    <>
      <Menu
        trigger={
          <IconButton
            icon="grid_view"
            label="Menu"
            className="border-transparent bg-transparent hover:bg-raised"
          />
        }
        align="end"
      >
        <MenuItem icon="history" label="Change Log" onSelect={() => setChangelogOpen(true)} />
        <MenuItem
          icon={isDark ? "light_mode" : "dark_mode"}
          label="Theme"
          onSelect={() => toggleTheme()}
        />
        <MenuItem
          icon="power_settings_new"
          label="Shutdown"
          danger
          onSelect={() => setShutdownOpen(true)}
        />
        <MenuItem icon="logout" label="Logout" danger onSelect={() => onLogout()} />
      </Menu>

      <ChangelogModal isOpen={changelogOpen} onClose={() => setChangelogOpen(false)} />
      <ConfirmDialog
        isOpen={shutdownOpen}
        onClose={() => setShutdownOpen(false)}
        onConfirm={handleShutdown}
        title="Close Proxy"
        message="Are you sure you want to close the proxy server?"
        confirmText="Close"
        cancelText="Cancel"
        variant="danger"
        loading={isShuttingDown}
      />
    </>
  );
}

HeaderMenu.propTypes = {
  onLogout: PropTypes.func.isRequired,
};
