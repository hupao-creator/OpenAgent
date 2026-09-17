# Settings page forms

These presentation components cover forms inside the global settings page only.
The page owns navigation, transitions, draft lifecycle, product-level validation and
save/cancel. Harness plugins own field definitions, catalog discovery, parsing and
business rules. No form schema or additional plugin protocol is required.

`HarnessSettingsPage` provides `SettingsFormScope`. A plugin field also used by a
thread can check `useSettingsFormPage()` to choose the page presentation while
retaining its existing thread UI. CSS is scoped to `.settings-page`.

```tsx
<SettingsGroup title={t('Bart Host')} description={t('用于协调 Agent。')}>
  <SettingsRow label={t('模型')} description={t('留空时使用原生默认值。')}>
    <SettingsSelect value={value.model} onChange={handleModelChange}>
      {options}
    </SettingsSelect>
  </SettingsRow>
  <SettingsRow label={t('高级规则')} layout="stacked" error={parseError}>
    <SettingsTextarea value={rulesText} onChange={handleRulesChange} />
  </SettingsRow>
</SettingsGroup>
```

- `SettingsRow` connects its label, description and error to a child control via
  context. If a control needs an explicit ID, pass the same ID as the row's
  `htmlFor`. Use one primary control per row; auxiliary actions may be siblings.
- Inputs, selects, textareas and toggles accept native controlled props and refs.
  Translate copy in the caller. Toggles are native checkboxes with switch semantics.
- `SettingsGroup` supports an optional `action` slot. `SettingsNotice` accepts
  `info`, `warning`, `error` or `success` tone and optional action.
- Complex editors can be composed inside rows or groups without moving their
  behavior into this library.
- `SettingsCliStatus` reports CLI availability. The host auto-detects the executable and
  refreshes discovery, so the plugin supplies only translated labels, status and error.
- Do not add page shells, navigation, save bars, data fetching or harness-specific
  business logic here. Do not migrate thread settings as part of a page-only change.
