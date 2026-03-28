/**
 * Dashboard Configuration Types and Validator
 * Provides reusable types and validation for admin dashboard personalization
 */

export interface DashboardWidget {
  id: string;
  type: string;
  position: number;
  size: "small" | "medium" | "large";
  visible: boolean;
  [key: string]: unknown;
}

export interface DashboardConfig {
  layout: "grid" | "flex" | "custom";
  widgets: DashboardWidget[];
  theme?: string;
  refreshInterval?: number;
  [key: string]: unknown;
}

/**
 * Validates a dashboard configuration object against the schema
 * @param config - The configuration object to validate
 * @returns true if config matches DashboardConfig schema, false otherwise
 */
export const validateDashboardConfig = (
  config: unknown,
): config is DashboardConfig => {
  if (!config || typeof config !== "object") {
    return false;
  }

  const cfg = config as Record<string, unknown>;

  // Validate required fields
  if (!cfg.layout || typeof cfg.layout !== "string") {
    return false;
  }

  if (!["grid", "flex", "custom"].includes(cfg.layout as string)) {
    return false;
  }

  if (!Array.isArray(cfg.widgets)) {
    return false;
  }

  // Validate widgets array
  for (const widget of cfg.widgets) {
    if (typeof widget !== "object" || !widget) {
      return false;
    }

    const w = widget as Record<string, unknown>;

    if (!w.id || typeof w.id !== "string") {
      return false;
    }

    if (!w.type || typeof w.type !== "string") {
      return false;
    }

    if (typeof w.position !== "number" || w.position < 0) {
      return false;
    }

    if (!["small", "medium", "large"].includes(w.size as string)) {
      return false;
    }

    if (typeof w.visible !== "boolean") {
      return false;
    }
  }

  // Optional fields validation
  if (cfg.theme && typeof cfg.theme !== "string") {
    return false;
  }

  if (cfg.refreshInterval && typeof cfg.refreshInterval !== "number") {
    return false;
  }

  return true;
};

/**
 * Creates a default dashboard configuration
 * @returns Default DashboardConfig
 */
export const createDefaultDashboardConfig = (): DashboardConfig => {
  return {
    layout: "grid",
    widgets: [],
  };
};

/**
 * Validation error messages for dashboard config
 */
export const DASHBOARD_CONFIG_VALIDATION_ERRORS = [
  "Config must have a valid layout (grid, flex, custom)",
  "Config must have a widgets array with valid widget objects",
  "Each widget must have: id (string), type (string), position (number), size (small/medium/large), visible (boolean)",
  "Optional fields: theme (string), refreshInterval (number)",
];