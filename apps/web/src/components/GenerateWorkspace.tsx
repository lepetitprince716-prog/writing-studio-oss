/**
 * Chapter generation workspace (center area of generate mode).
 * Setup form → outline composer + large streaming preview → explicit adoption.
 * The generation session is an ordinary document-level rewrite thread, so the
 * AI tab shows the same conversation and the stop/stream machinery is shared.
 */

import { useEffect, useRef, useState } from 'react';
import type { AgentId } from '@writing-studio/contract';
import { useStudio } from '../store.js';
import { countWords } from '../lib/wordCount.js';
import { ContextManifestPanel } from './ContextManifestPanel.js';
import { GenerateRecapPanel } from './GenerateRecapPanel.js';

export function GenerateWorkspace(): React.JSX.Element {
  const generateDoc = useStudio((s) => s.generateDoc);
  const activeThread = useStudio((s) => s.activeThread);
  const messages = useStudio((s) => s.messages);
  const streamingText = useStudio((s) => s.streamingText);
  const running = useStudio((s) => s.running);
  const agents = useStudio((s) => s.agents);
  const agentsLoaded = useStudio((s) => s.agentsLoaded);
  const modelPrefs = useStudio((s) => s.modelPrefs);
  const composerFocusNonce = useStudio((s) => s.composerFocusNonce);
  const runManifest = useStudio((s) => s.runManifest);
  const beats = useStudio((s) => s.beats);
  const beatIndex = useStudio((s) => s.beatIndex);
  const beatTexts = useStudio((s) => s.beatTexts);
  const beatPhase = useStudio((s) => s.beatPhase);
  const beatRewriting = useStudio((s) => s.beatRewriting);

  const startChapterGeneration = useStudio((s) => s.startChapterGeneration);
  const adoptGeneratedChapter = useStudio((s) => s.adoptGeneratedChapter);
  const startGenerationBeats = useStudio((s) => s.startGenerationBeats);
  const continueGenerationBeat = useStudio((s) => s.continueGenerationBeat);
  const retryGenerationBeat = useStudio((s) => s.retryGenerationBeat);
  const rewriteGenerationBeat = useStudio((s) => s.rewriteGenerationBeat);
  const stopRun = useStudio((s) => s.stopRun);
  const setThreadAgent = useStudio((s) => s.setThreadAgent);
  const setAgentModel = useStudio((s) => s.setAgentModel);

  const [title, setTitle] = useState('');
  const [target, setTarget] = useState<'chapter' | 'draft'>('chapter');
  const [outline, setOutline] = useState('');
  const outlineRef = useRef<HTMLTextAreaElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);

  const sessionActive = generateDoc !== null && activeThread !== null;
  const lastCandidate = [...messages].reverse().find(
    (message) => message.role === 'assistant'
      && (
        message.structured && 'rewritten_text' in message.structured
          ? message.structured.rewritten_text
          : message.content
      ).trim() !== '',
  );
  const candidateText = lastCandidate
    ? lastCandidate.structured && 'rewritten_text' in lastCandidate.structured
      ? lastCandidate.structured.rewritten_text
      : lastCandidate.content
    : '';
  const previewText = beats.length > 0
    ? beatPhase === 'done' ? beatTexts.join('\n\n') : beatTexts[beatIndex] ?? ''
    : candidateText;
  const availability = activeThread
    ? agents.find((agent) => agent.agentId === activeThread.agentId)
    : undefined;
  const models = availability?.models;
  const currentModel = activeThread ? modelPrefs[activeThread.agentId] ?? '' : '';

  useEffect(() => {
    if (sessionActive && composerFocusNonce > 0) outlineRef.current?.focus();
  }, [sessionActive, composerFocusNonce]);

  // Keep the preview pinned to the newest streamed text.
  useEffect(() => {
    const preview = previewRef.current;
    if (preview && running) preview.scrollTop = preview.scrollHeight;
  }, [streamingText, running]);

  async function sendOutline(): Promise<void> {
    if (!outline.trim() || running || beats.length > 0) return;
    if (await startGenerationBeats(outline)) setOutline('');
  }

  async function rewriteBeat(): Promise<void> {
    if (!outline.trim() || running) return;
    if (await rewriteGenerationBeat(outline)) setOutline('');
  }

  if (!sessionActive) {
    return (
      <div className="generate-workspace">
        <div className="generate-setup-layout">
          <div className="generate-setup">
            <h2 className="generate-heading">生成新章</h2>
            <p className="generate-sub">
              面板自动注入写手资料（写作状态、设定摘录），你只需提供本章标题与章纲。
            </p>
            <label className="modal-field">
              <span className="modal-field-label">章节标题</span>
              <input
                className="modal-input"
                value={title}
                maxLength={60}
                placeholder="本章标题"
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <div className="generate-target" role="radiogroup" aria-label="生成目标">
              <label>
                <input
                  type="radio"
                  name="generate-target"
                  checked={target === 'chapter'}
                  onChange={() => setTarget('chapter')}
                />
                正文新章
              </label>
              <label>
                <input
                  type="radio"
                  name="generate-target"
                  checked={target === 'draft'}
                  onChange={() => setTarget('draft')}
                />
                草稿
              </label>
            </div>
            <button
              className="btn-primary"
              disabled={!title.trim() || !agentsLoaded}
              onClick={() => void startChapterGeneration({ title: title.trim(), target })}
            >
              创建目标并开始
            </button>
          </div>
          <div className="generate-setup-recap">
            <GenerateRecapPanel phase="setup" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="generate-workspace">
      <div className="generate-header">
        <div>
          <span className="generate-doc-title">{generateDoc.title}</span>
          <span className="generate-doc-path">{generateDoc.docId}</span>
        </div>
        <div className="generate-header-tools">
          <label>
            Agent
            <select
              className="agent-select"
              value={activeThread.agentId}
              disabled={running || !agentsLoaded}
              onChange={(event) => void setThreadAgent(event.target.value as AgentId)}
            >
              {agents.length === 0 && (
                <option value={activeThread.agentId}>{activeThread.agentId}</option>
              )}
              {agents.map((agent) => {
                const usable = agent.ok && agent.supportedProfiles.includes(activeThread.profile);
                return (
                  <option key={agent.agentId} value={agent.agentId} disabled={!usable}>
                    {agent.agentId}{usable ? '' : '（不可用）'}
                  </option>
                );
              })}
            </select>
          </label>
          {models !== undefined && (
            <label>
              模型
              <select
                className="agent-select"
                value={currentModel}
                onChange={(event) => setAgentModel(activeThread.agentId, event.target.value || null)}
              >
                <option value="">默认</option>
                {models.map((model) => (
                  <option key={model.id} value={model.id}>{model.label}</option>
                ))}
                {currentModel !== '' && !models.some((model) => model.id === currentModel) && (
                  <option value={currentModel}>{currentModel}</option>
                )}
              </select>
            </label>
          )}
        </div>
      </div>

      <GenerateRecapPanel phase="session" />

      {beats.length > 0 && (
        <div className="generate-beat-progress" aria-label="情节拍进度">
          <strong>第 {beatIndex + 1}/{beats.length} 拍</strong>
          <ol>
            {beats.map((_, index) => {
              const status = index === beatIndex && running
                ? beatRewriting ? '重写中' : '写作中'
                : beatTexts[index] ? '已写' : '待写';
              return (
                <li key={index} aria-current={index === beatIndex ? 'step' : undefined}>
                  第 {index + 1} 拍 · {status}
                </li>
              );
            })}
          </ol>
        </div>
      )}

      <ContextManifestPanel manifest={runManifest} />
      <div className="generate-preview" ref={previewRef}>
        {running ? (
          <pre className="generate-stream">
            {streamingText || '正在生成…'}
            <span className="stream-cursor" />
          </pre>
        ) : previewText ? (
          <pre className="generate-candidate">{previewText}</pre>
        ) : (
          <div className="generate-empty">输入章纲后开始生成；生成结果会显示在这里。</div>
        )}
      </div>

      {!running && beatPhase === 'awaiting-confirm' && previewText && (
        <div className="generate-actions">
          <span className="generate-count">本拍 {countWords(previewText)} 字</span>
          <button className="btn-primary" onClick={() => void continueGenerationBeat()}>
            继续下一拍
          </button>
        </div>
      )}

      {!running && beatPhase === 'done' && previewText && (
        <div className="generate-actions">
          <span className="generate-count">全文 {countWords(previewText)} 字</span>
          <button
            className="btn-primary"
            onClick={() => void adoptGeneratedChapter()}
          >
            采纳并进入编辑
          </button>
        </div>
      )}

      {beatPhase !== 'done' && (
        <div className="generate-composer">
          <textarea
            ref={outlineRef}
            value={outline}
            placeholder={beats.length === 0
              ? '本章章纲（用独行 --- 分拍）…（⌘↵ 发送，Esc 停止）'
              : beatPhase === 'awaiting-confirm'
                ? '填写本拍重写意见…（⌘↵ 重写）'
                : '当前拍停止，可点击重试'}
            disabled={beats.length > 0 && beatPhase === 'writing'}
            onChange={(event) => setOutline(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Escape' && running) {
                event.preventDefault();
                event.stopPropagation();
                void stopRun();
                return;
              }
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                if (beatPhase === 'awaiting-confirm') void rewriteBeat();
                else void sendOutline();
              }
            }}
          />
          {running ? (
            <button className="btn-ghost danger" onClick={() => void stopRun()}>
              停止 Esc
            </button>
          ) : beatPhase === 'awaiting-confirm' ? (
            <button
              className="btn-ghost"
              disabled={!outline.trim()}
              onClick={() => void rewriteBeat()}
            >
              重写本拍
            </button>
          ) : beats.length > 0 ? (
            <button className="btn-primary" onClick={() => void retryGenerationBeat()}>
              重试本拍
            </button>
          ) : (
            <button
              className="btn-primary"
              disabled={!outline.trim()}
              onClick={() => void sendOutline()}
            >
              发送 ⌘↵
            </button>
          )}
        </div>
      )}
    </div>
  );
}
