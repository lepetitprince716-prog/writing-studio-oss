import type { CanonSectionRef } from '@writing-studio/contract';

export function CanonRepairButton({
  section,
  onRepair,
}: {
  section: CanonSectionRef | undefined;
  onRepair: (section: CanonSectionRef) => void;
}): React.JSX.Element | null {
  if (!section) return null;
  return (
    <button
      type="button"
      className="btn canon-repair-btn"
      onClick={(event) => {
        event.stopPropagation();
        onRepair(section);
      }}
    >
      修订此节
    </button>
  );
}
