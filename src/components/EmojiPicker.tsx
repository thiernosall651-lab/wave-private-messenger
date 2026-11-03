const EMOJIS = [
  "😀", "😁", "😂", "🤣", "😊", "😍", "🥰", "😘", "😎", "🤩", "🥳", "😇", "🙂", "😉", "😋", "🤗",
  "🤔", "😏", "😴", "😢", "😭", "😡", "🥺", "😅", "🙈", "🙏", "👍", "👎", "👏", "🙌", "💪", "🤝",
  "👌", "✌️", "🤞", "👋", "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "💔", "💕", "💯", "🔥", "✨",
  "🎉", "🎶", "🌹", "☀️", "🌙", "⭐", "🍕", "☕", "🎂", "🎁", "⚽", "🚗", "✈️", "📞", "💬", "😮",
] as const;

/** Petit panneau d'emojis ouvert au-dessus de la zone de saisie. */
export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  return (
    <div role="group" aria-label="Emojis" className="msg-in absolute bottom-14 left-0 right-0 z-30 max-h-44 overflow-y-auto rounded-xl border border-border bg-popover p-2 shadow-lg">
      <div className="grid grid-cols-8 gap-1">
        {EMOJIS.map((emoji) => (
          <button key={emoji} type="button" onClick={() => onPick(emoji)} aria-label={`Insert ${emoji}`} className="rounded-lg py-1.5 text-xl hover:bg-secondary">
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}
