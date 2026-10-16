import type { KeyboardEvent } from 'react';

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onInput: () => void;
  streaming: boolean;
  writing: boolean;
}

export function Composer({ value, onChange, onSend, onStop, onInput, streaming, writing }: ComposerProps) {
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
        value={value}
        rows={2}
        autoFocus
        disabled={streaming}
        placeholder={streaming ? '正在生成，可以点「停止」打断' : '输入你的问题，Enter 发送，Shift + Enter 换行'}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="composer__footer">
        <span className="composer__hint">Enter 发送 · Shift + Enter 换行</span>
        <div className="composer__actions">
          <button
            type="button"
            className="composer__write"
            onClick={onInput}
            disabled={streaming || writing || !value.trim()}
            title={
              streaming
                ? '正在生成，先点「停止」再输入'
                : '把输入框里的文本整段写进作答区（PTA 禁粘贴时的快捷通道），会清空输入框'
            }
          >
            {writing ? '输入中' : '输入'}
          </button>
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
