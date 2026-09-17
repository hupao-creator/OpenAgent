import { useMemo, type ComponentProps } from 'react'
import { I18nProvider } from '@openagent/plugin-kit/renderer'
import { coreRendererTranslations } from './translations'

/** The desktop owns product copy and explicitly supplies it to the shared engine. */
export function AppI18nProvider(props: ComponentProps<typeof I18nProvider>): React.JSX.Element {
  const translations = useMemo(() => ({
    'en-US': {
      ...props.translations?.['en-US'],
      ...coreRendererTranslations['en-US']
    }
  }), [props.translations])
  return <I18nProvider {...props} translations={translations} />
}
