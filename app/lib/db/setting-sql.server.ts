import { isSettingKey, type SettingKey, settingSpec } from "../settings";

/**
 * The SQL for a setting's value in force, read inside the statement that
 * uses it, so a write always follows the value of its moment.
 */
export function settingSql(key: SettingKey): string {
  if (!isSettingKey(key)) throw new Error(`unknown setting ${String(key)}`);
  return `COALESCE((SELECT value FROM settings WHERE key = '${key}'), ${settingSpec(key).default})`;
}
