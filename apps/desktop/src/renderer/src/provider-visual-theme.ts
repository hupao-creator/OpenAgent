interface ProviderVisualTheme {
  id: string
  className: `provider-theme-${string}`
}

export function providerVisualTheme(provider: string): ProviderVisualTheme {
  return {
    id: provider,
    className: providerVisualThemeClassName(provider)
  }
}

export function providerVisualThemeClassName(
  provider: string
): ProviderVisualTheme['className'] {
  return `provider-theme-${provider}`
}
