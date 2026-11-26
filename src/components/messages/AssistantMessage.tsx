import { useTranslate } from '../../i18n/index.js'
import clsx from 'clsx'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { android } from '../../app/android.js'
import {
  IconCopyOutline16,
  IconPlayMediaOutline16,
  IconRefreshOutline16,
  IconSelectTextOutline16,
  IconWarningOutline16,
} from '../base/icons.js'
import { describeReply } from '../../services/chat/describe.js'
import { canContinueReply } from '../../services/chat/reply.js'
import { continueReply, regenerateReply } from '../../services/chat/store.js'
import {
  describeReadAloudError,
  stopReadAloud,
  toggleReadAloud,
} from '../../services/speech/readAloud.js'
import { useSettings } from '../../services/settings.js'
import { showToast } from '../base/toastState.js'
import type { AssistantMessage as AssistantMessageType } from '../../services/chat/types.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { copyText as copyToClipboard } from '../../utils/clipboard.js'
import { IconButton } from '../base/IconButton.js'
import { Button } from '../base/Button.js'
import { Menu } from '../base/Menu.js'
import { Markdown } from '../markdown/Markdown.js'
import { formatAndroidCopyText } from '../../services/markdown/copyText.js'
import { SiteThumbnails } from '../search/SiteLogo.js'
import { toggleSearchPanel, useSearchPanel } from '../search/searchPanelState.js'
import { AndroidTextSelection } from './AndroidTextSelection.js'
import { PythonCharts } from '../../elsewhere/python/PythonCharts.js'
import { useAttachmentProgress } from '../../elsewhere/attachments/progress.js'
import { isTtsReady, useVoiceConfig } from '../../elsewhere/voice/config.js'
import { ReadAloudButton } from './ReadAloudButton.js'
import { CopyButton } from './CopyButton.js'
import { ReplyArea } from './ReplyArea.js'
import { useReplyView } from './useReplyView.js'
import {
  BranchSwitcher,
  type MessageVersions,
  type SelectMessageVersion,
} from './BranchSwitcher.js'
import styles from './AssistantMessage.module.css'

const TOP_UP_URL = 'https://platform.deepseek.com/top_up'

export const AssistantMessage = memo(function AssistantMessage({
  sessionId,
  message,
  isLast,
  streaming,
  busy,
  searchHighlightNonce = null,
  versions,
  onSelectVersion,
}: {
  sessionId: string
  message: AssistantMessageType
  isLast: boolean
  streaming: boolean
  busy: boolean
  searchHighlightNonce?: number | null
  versions: MessageVersions
  onSelectVersion: SelectMessageVersion
}) {
  const t = useTranslate()
  const customEndpoint = useSettings((state) => Boolean(state.chatConfig.endpoint))
  const zh = useSettings((state) => state.locale === 'zh-CN')
  const attachmentProgress = useAttachmentProgress((state) => state.sessions[sessionId])
  const format = useSettings((state) => state.chatConfig.format)
  const deepSeekApiKey = useSettings((state) => state.apiKey)
  const voiceConfig = useVoiceConfig((state) => state.config)
  const voiceTtsApiKey = useVoiceConfig((state) => state.secrets.ttsApiKey)
  const canReadAloud = isTtsReady(voiceConfig, deepSeekApiKey, voiceTtsApiKey)
  const view = useReplyView(message, streaming)
  const panelEntry = useSearchPanel((state) => state.entry)
  const notice = streaming ? null : describeReply(message)
  // 安全拒绝：已下发的思考与正文按协议丢弃，只显示模板答复。
  const refused = message.stopReason === 'refusal'
  const answer = refused ? null : view.answer
  const responseText = [answer?.text, notice?.presentation === 'response' ? notice.text : null]
    .filter(Boolean)
    .join('\n\n')
  const copyText = useMemo(() => {
    if (!android) {
      return responseText || notice?.text
    }
    if (responseText) {
      return formatAndroidCopyText(responseText) || responseText
    }
    return notice?.text
  }, [notice?.text, responseText])
  const [selecting, setSelecting] = useState(false)
  const [selectionPoint, setSelectionPoint] = useState<{ x: number; y: number } | undefined>()
  const [menuOffset, setMenuOffset] = useState<{ x: number; y: number } | undefined>()
  const lastTouchRef = useRef<{ x: number; y: number } | undefined>(undefined)
  const selectableRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  const wasStreaming = useRef(streaming)

  const stopSelecting = useCallback(() => {
    setSelecting(false)
  }, [])

  const startSelecting = () => {
    setSelecting(true)
  }

  const copyAssistantText = () => {
    if (!copyText) {
      return
    }
    void copyToClipboard(copyText).then((copied) =>
      showToast({ key: copied ? 'copied' : 'copyFailed' }, copied ? 1990 : undefined)
    )
  }
  useEffect(() => {
    const voiceState = useVoiceConfig.getState()
    const settingsState = useSettings.getState()
    if (
      android &&
      wasStreaming.current &&
      !streaming &&
      isLast &&
      responseText &&
      message.stopReason === 'end_turn' &&
      settingsState.autoRead &&
      isTtsReady(voiceState.config, settingsState.apiKey, voiceState.secrets.ttsApiKey)
    ) {
      toggleReadAloud(message.id, responseText, (error) => showToast(describeReadAloudError(error)))
    }
    wasStreaming.current = streaming
  }, [isLast, message.id, message.stopReason, responseText, streaming])
  const waiting =
    streaming && view.steps.length === 0 && !view.answer && (android || !message.thinking)
  const progressText = attachmentProgress?.length
    ? attachmentProgress
        .map((item) => {
          const count = item.current && item.total ? `（${item.current}/${item.total}）` : ''
          const enCount = item.current && item.total ? ` (${item.current}/${item.total})` : ''
          if (item.kind === 'slice') {return zh ? `正在切分长图${count}` : `Slicing long image${enCount}`}
          if (item.kind === 'pdf_render') {
            return zh ? `正在渲染扫描页${count}` : `Rendering scanned pages${enCount}`
          }
          return zh ? '正在提取 PDF 文本' : 'Extracting PDF text'
        })
        .join(zh ? '，' : ', ')
    : ''
  const hasClientTools = view.steps.some((step) => step.type === 'client_tool')
  const summaryEntry = `${message.id}-summary`
  return (
    <div
      className={clsx(styles.message, searchHighlightNonce !== null && styles.searchHighlighted)}
      data-message-id={message.id}
    >
      {searchHighlightNonce !== null ? (
        <div key={searchHighlightNonce} className={styles.searchHighlight} aria-hidden="true" />
      ) : null}
      {refused ? null : (
        <ReplyArea
          message={message}
          view={view}
          streaming={streaming}
          hasResponse={!!responseText}
        />
      )}
      <div
        ref={selectableRef}
        className={styles.selectable}
        onPointerDown={(event) => {
          if (android) {
            lastTouchRef.current = { x: event.clientX, y: event.clientY }
          }
        }}
        onContextMenu={(event) => {
          if (!android || !responseText) {
            return
          }
          event.preventDefault()
          event.stopPropagation()
          stopSelecting()
          const point =
            event.clientX || event.clientY
              ? { x: event.clientX, y: event.clientY }
              : lastTouchRef.current
          setSelectionPoint(point)
          const rect = selectableRef.current?.getBoundingClientRect()
          if (point && rect) {
            setMenuOffset({
              x: Math.max(0, Math.min(rect.width, point.x - rect.left)),
              y: Math.max(0, Math.min(rect.height, point.y - rect.top)),
            })
          }
          requestAnimationFrame(() => menuTriggerRef.current?.click())
        }}
        onClickCapture={(event) => {
          if (selecting && contentRef.current?.contains(event.target as Node)) {
            event.preventDefault()
            event.stopPropagation()
            stopSelecting()
          }
        }}
      >
        {android && responseText ? (
          <span
            className={styles.menuAnchor}
            style={menuOffset ? { left: menuOffset.x, top: menuOffset.y } : undefined}
          >
            <Menu
              variant="assistantMessage"
              options={[
                {
                  key: 'copy',
                  label: t('copy'),
                  icon: <IconCopyOutline16 />,
                  onSelect: copyAssistantText,
                },
                {
                  key: 'selectText',
                  label: t('androidSelectText'),
                  icon: <IconSelectTextOutline16 />,
                  onSelect: startSelecting,
                },
                {
                  key: 'regenerate',
                  label: t('regenerate'),
                  icon: <IconRefreshOutline16 />,
                  onSelect: () => {
                    stopReadAloud()
                    regenerateReply(sessionId, message.id)
                  },
                },
                ...(canReadAloud
                  ? [
                      {
                        key: 'read',
                        label: t('ttsPlay'),
                        icon: <IconPlayMediaOutline16 />,
                        onSelect: () =>
                          toggleReadAloud(message.id, responseText, (error) =>
                            showToast(describeReadAloudError(error))
                          ),
                      },
                    ]
                  : []),
              ]}
            >
              {({ toggle }) => (
                <button
                  ref={menuTriggerRef}
                  className={styles.menuTrigger}
                  type="button"
                  aria-hidden="true"
                  tabIndex={-1}
                  onClick={(event) => {
                    event.stopPropagation()
                    toggle()
                  }}
                />
              )}
            </Menu>
          </span>
        ) : null}
        <div ref={contentRef} className={styles.selectableContent}>
          {answer ? (
            <Markdown
              className="ds-assistant-message-main-content"
              content={answer.markdown}
              loading={streaming}
              cacheKey={message.id}
              disableLink={false}
              sources={view.sources}
            />
          ) : null}
          {notice?.presentation === 'response' ? (
            <Markdown
              className="ds-assistant-message-main-content"
              content={notice.text}
              loading={false}
              cacheKey={`${message.id}-template`}
              disableLink={false}
            />
          ) : notice ? (
            <div className={styles.notice}>
              <IconWarningOutline16 />
              <span>
                {notice.text}
                {notice.action === 'apiKey' ? (
                  <>
                    {' '}
                    <button
                      type="button"
                      className={styles.noticeAction}
                      onClick={() => openSettings(customEndpoint ? 'advanced' : 'data')}
                    >
                      {t('changeApiKey')}
                    </button>
                  </>
                ) : null}
                {notice.action === 'topUp' && !customEndpoint ? (
                  <>
                    {' '}
                    <a
                      className={styles.noticeAction}
                      href={TOP_UP_URL}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t('topUp')}
                    </a>
                  </>
                ) : null}
              </span>
            </div>
          ) : null}
        </div>
        {android ? (
          <AndroidTextSelection
            active={selecting}
            containerRef={selectableRef}
            contentRef={contentRef}
            initialMode="block"
            initialPoint={selectionPoint}
            fullCopyText={copyText}
            onExit={stopSelecting}
          />
        ) : null}
      </div>
      <PythonCharts message={message} />
      {waiting ? (
        progressText ? (
          <div className={clsx(styles.waiting, styles.processing)}>
            <span className={styles.processingSpinner} />
            <span>{progressText}</span>
          </div>
        ) : (
          <div className={styles.waiting}>
            {[0, 1, 2].map((index) => (
              <span key={index} className={styles.waitingDot} />
            ))}
          </div>
        )
      ) : null}
      {!streaming && !refused && !hasClientTools && view.searchResults.length > 0 ? (
        <div
          className={clsx(styles.summary, panelEntry === summaryEntry && styles.summaryActive)}
          role="button"
          tabIndex={0}
          aria-expanded={panelEntry === summaryEntry}
          onClick={() => toggleSearchPanel(summaryEntry, view.searchResults)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              toggleSearchPanel(summaryEntry, view.searchResults)
            }
          }}
        >
          <SiteThumbnails sources={view.searchResults} />
          <span>
            {t(
              view.searchResults.length === 1 ? 'messageSearchSummary' : 'messageSearchSummaries',
              { count: view.searchResults.length }
            )}
          </span>
        </div>
      ) : null}
      {streaming ? null : (
        <div className={styles.bottom}>
          <BranchSwitcher versions={versions} disabled={busy} onSelect={onSelectVersion} />
          <div className={clsx(styles.actions, isLast && styles.alwaysShow)}>
            {copyText ? (
              <CopyButton
                text={copyText}
                buttonProps={
                  android
                    ? {
                        tabIndex: -1,
                        onMouseDown: (event) => event.preventDefault(),
                      }
                    : undefined
                }
              />
            ) : null}
            {responseText && !refused && canReadAloud ? (
              <ReadAloudButton messageId={message.id} text={responseText} />
            ) : null}
            <IconButton
              className={styles.regenerate}
              icon={<IconRefreshOutline16 />}
              tooltip={t('regenerate')}
              tooltipPlacement="bottom"
              disabled={busy || refused}
              onClick={() => {
                stopReadAloud()
                regenerateReply(sessionId, message.id)
              }}
            />
          </div>
          {isLast && !customEndpoint && format === 'messages' && canContinueReply(message) ? (
            <Button
              variant="outlined"
              size="s"
              className={styles.continueButton}
              disabled={busy}
              onClick={() => {
                stopReadAloud()
                continueReply(sessionId, message.id)
              }}
            >
              {t('continueGenerating')}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
})
