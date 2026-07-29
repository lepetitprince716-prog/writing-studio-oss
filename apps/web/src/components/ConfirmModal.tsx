import { useStudio } from '../store.js';
import { Modal } from './Modal.js';

/** Promise-backed confirmation host used by store actions. */
export function ConfirmModal(): React.JSX.Element {
  const dialog = useStudio((state) => state.confirmDialog);
  const resolve = useStudio((state) => state.resolveConfirm);

  return (
    <Modal
      open={dialog !== null}
      title={dialog?.title ?? ''}
      confirmText={dialog?.confirmText ?? '确认'}
      onClose={() => resolve(false)}
      onConfirm={() => resolve(true)}
    >
      <p className="confirm-message">{dialog?.message}</p>
    </Modal>
  );
}
