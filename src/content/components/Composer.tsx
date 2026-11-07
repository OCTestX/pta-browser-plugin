import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';

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
}

export function Composer({ value, onChange, onSend, onStop, streaming, focusSignal = 0 }: ComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 面板刚挂载时输入框还不存在，autoFocus 已经把光标放进去了；
  // 这里补的是「面板早就开着、再按一次 Alt+G」的情况——那时组件不会重新挂载。
  useEffect(() => {
    if (focusSignal > 0) inputRef.current?.focus();
  }, [focusSignal]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 中文输入法组词期间的回车不能被当成发送
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onSend();
    }
  };

  return (
    <div className="composer">
      <textarea
        className="composer__input"
        ref={inputRef}
        value={value}
        rows={2}
        autoFocus
        disabled={streaming}
        placeholder={
          streaming ? '正在生成，可以点「停止」打断' : '输入你的问题，Enter 发送，Shift + Enter 换行'
        }
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="composer__footer">
        <span className="composer__hint">Enter 发送 · Shift + Enter 换行</span>
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
