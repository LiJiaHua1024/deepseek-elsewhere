import { useState } from 'react'
import whale from '../../assets/elsewhere-whale.svg'
import { ModelServicesDialog } from '../../elsewhere/models/ModelSettingsViews.js'
import { useIsZh } from '../../elsewhere/text.js'
import { useTranslate } from '../../i18n/index.js'
import advancedStyles from './AdvancedApiSettings.module.css'
import { useApiKeyForm } from './useApiKeyForm.js'
import styles from './ApiKeyScreen.module.css'

export const ApiKeyScreen = () => {
  const t = useTranslate()
  const zh = useIsZh()
  const form = useApiKeyForm()
  const [advanced, setAdvanced] = useState(false)

  return (
    <main className={styles.page}>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault()
          void form.submit()
        }}
      >
        <img className={styles.whale} src={whale} alt="" />
        <h1>{t('apiKeyStart')}</h1>
        <input
          aria-label="DeepSeek API Key"
          aria-invalid={Boolean(form.error)}
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="go"
          placeholder={t('apiKeyPlaceholder')}
          value={form.value}
          onChange={(event) => form.setValue(event.target.value)}
        />
        {form.error ? (
          <div role="alert" className={styles.error}>
            {form.error}
          </div>
        ) : null}
        <button type="submit" disabled={form.verifying || !form.value.trim()}>
          {t(form.verifying ? 'apiKeyVerifying' : 'confirm')}
        </button>
        <a href="https://platform.deepseek.com/api_keys">{t('apiKeyGet')}</a>
        <button className={advancedStyles.entry} type="button" onClick={() => setAdvanced(true)}>
          {zh ? '配置其他模型服务' : 'Configure other model services'}
        </button>
      </form>
      {advanced ? <ModelServicesDialog onClose={() => setAdvanced(false)} /> : null}
    </main>
  )
}
