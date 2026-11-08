import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { filterSlashCommands } from '../../shared/commands';

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  /**
   * 聚焦信号：每次自增就表示「把光标放进输入框」。
   * Alt+G 打开悬浮窗时会自增，这样用户不用再点一下输入框就能直接打字。
   */
  focusSignal?: number;
  /** 开新会话（连按三次回车、或选中 /new） */
  onReset?: () => void;
  /** 发送一条指定内容（斜杠指令选中后直接发出去） */
  onSendText?: (text: string) => void;
}

/** 空输入框连按几次回车算「开新会话」 */
const EMPTY_ENTER_TIMES = 3;

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  focusSignal = 0,
  onReset,
  onSendText,
}: ComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 空输入框连按回车：记着已经按了几次
  const emptyEnterRef = useRef(0);
  const [emptyEnterLeft, setEmptyEnterLeft] = useState(0);
  // 斜杠指令菜单：输入框以「/」开头时弹出来
  const [commandIndex, setCommandIndex] = useState(0);

  // 面板刚挂载时输入框还不存在，autoFocus 已经把光标放进去了；
  // 这里补的是「面板早就开着、再按一次 Alt+G」的情况——那时组件不会重新挂载。
  useEffect(() => {
    if (focusSignal > 0) inputRef.current?.focus();
  }, [focusSignal]);

  // 输入内容变了，指令菜单的候选与高亮项都要跟着重算
  const commandQuery = value.startsWith('/') ? value.slice(1).split(/\s/)[0] : '';
  const commands = useMemo(
    () => (value.startsWith('/') ? filterSlashCommands(commandQuery) : []),
    [value, commandQuery],
  );
  const menuOpen = commands.length > 0 && value.startsWith('/');
  useEffect(() => {
    setCommandIndex(0);
  }, [commandQuery]);

  const pickCommand = (index: number) => {
    const command = commands[index];
    if (!command) return;
    // /new 是纯界面动作：直接开新会话，不浪费一次模型往返
    if (command.id === 'new') {
      onChange('');
      onReset?.();
      return;
    }
    const text = command.name;
    onChange(text);
    onSendText?.(text);
  };

  /** Tab 补全：把选中的指令填进输入框（不直接发出去，让老用户习惯的「Tab 然后回车」成立） */
  const completeCommand = (index: number) => {
    const command = commands[index];
    if (!command) return;
    onChange(command.name);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 指令菜单开着时，上下键选、Tab 补全、回车发送
    if (menuOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setCommandIndex((index) => (index + 1) % commands.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setCommandIndex((index) => (index - 1 + commands.length) % commands.length);
        return;
      }
      if (event.key === 'Tab') {
        // Tab 在输入框里默认是跳焦点，抢过来当「补全当前选中的指令」用
        event.preventDefault();
        completeCommand(commandIndex);
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        pickCommand(commandIndex);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        onChange('');
        return;
      }
    }

    // 中文输入法组词期间的回车不能被当成发送
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!value.trim()) {
        // 输入框是空的：连按三次回车就开新会话
        const times = emptyEnterRef.current + 1;
        emptyEnterRef.current = times;
        if (times >= EMPTY_ENTER_TIMES) {
          emptyEnterRef.current = 0;
          setEmptyEnterLeft(0);
          onReset?.();
          return;
        }
        setEmptyEnterLeft(EMPTY_ENTER_TIMES - times);
        return;
      }
      emptyEnterRef.current = 0;
      setEmptyEnterLeft(0);
      onSend();
    }
  };

  return (
    <div className="composer">
      {menuOpen && (
        <div className="cmds" role="listbox" aria-label="可用指令">
          {commands.map((command, index) => (
            <button
              key={command.id}
              type="button"
              role="option"
              aria-selected={index === commandIndex}
              className={`cmds__item${index === commandIndex ? ' cmds__item--on' : ''}`}
              onMouseEnter={() => setCommandIndex(index)}
              onClick={() => pickCommand(index)}
            >
              <span className="cmds__name">{command.name}</span>
              <span className="cmds__summary">{command.summary}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        className="composer__input"
        ref={inputRef}
        value={value}
        rows={2}
        autoFocus
        disabled={streaming}
        title="Enter 发送，Shift + Enter 换行；输入框为空时连按三次回车开新会话；输入 / 可以看指令菜单"
        placeholder={
          streaming
            ? '正在生成，可以点「停止」打断'
            : '输入你的问题，Enter 发送，Shift + Enter 换行（输入 / 看指令）'
        }
        onChange={(event) => {
          onChange(event.target.value);
          if (event.target.value.trim()) {
            emptyEnterRef.current = 0;
            setEmptyEnterLeft(0);
          }
        }}
        onKeyDown={handleKeyDown}
      />
      <div className="composer__footer">
        {/* 底部只留「连按几次回车开新会话」这种一次性提示；
            发送/换行的快捷键已经写进输入框的 title（鼠标停上去就能看到），不再重复占地方 */}
        {emptyEnterLeft > 0 && <span className="composer__hint">再按 {emptyEnterLeft} 次回车开新会话</span>}
        <div className="composer__actions">
          {streaming ? (
            <button type="button" className="composer__send composer__send--stop" onClick={onStop}>
              停止
            </button>
          ) : (
            <button
              type="button"
              className="composer__send"
              onClick={onSend}
              disabled={!value.trim()}
            >
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
