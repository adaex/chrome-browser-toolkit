export interface FeatureSettings {
  deduplicate: boolean;
  fullscreen: boolean;
}

const FEATURE_KEYS = {
  deduplicate: 'featureSettings.deduplicate',
  fullscreen: 'featureSettings.fullscreen',
};
const SETTINGS_KEYS = ['featureSettings', ...Object.values(FEATURE_KEYS)];

// 每个开关单独保存；没改过的沿用旧对象里的值，只有显式 false 才关闭
export async function loadFeatureSettings(): Promise<FeatureSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEYS);
  const legacy = stored.featureSettings as Partial<FeatureSettings> | null | undefined;
  function read(feature: keyof FeatureSettings) {
    const value = stored[FEATURE_KEYS[feature]];
    return typeof value === 'boolean' ? value : legacy?.[feature] !== false;
  }
  return { deduplicate: read('deduplicate'), fullscreen: read('fullscreen') };
}

export function saveFeatureSetting(feature: keyof FeatureSettings, enabled: boolean): Promise<void> {
  return chrome.storage.local.set({ [FEATURE_KEYS[feature]]: enabled });
}
