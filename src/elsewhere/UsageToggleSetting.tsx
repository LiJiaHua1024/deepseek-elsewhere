import { setShowUsageInChat, useElsewherePrefs } from './preferences.js'
import { useIsZh } from './text.js'
import styles from './UsageToggleSetting.module.css'

/** Web/桌面端通用设置页里的「对话内显示轻量用量」开关项。 */
export const UsageToggleSetting = () => {
  const zh = useIsZh()
  const checked = useElsewherePrefs((state) => state.showUsageInChat)
  const label = zh ? '对话内显示轻量用量' : 'Show compact usage in chat'
  const description = zh
    ? '在输入栏右侧显示上下文占用圆环，并在触发摘要时显示提示'
    : 'Show context ring in composer and summary divider in chat'

  return (
    <div className={styles.cell}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        <div className={styles.description}>{description}</div>
      </div>
      <button
        type="button"
        className={styles.switch}
        role="switch"
        aria-label={label}
        aria-checked={checked}
        onClick={() => setShowUsageInChat(!checked)}
      >
        <span />
      </button>
    </div>
  )
}
