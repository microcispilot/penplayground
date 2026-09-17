import { Button, Dialog, TextField, useToast } from '@pen/design';
import { useState } from 'react';
import { useApp } from '../lib/context.js';

/** Anonymous identity today: a display name for captions and rooms. Accounts land on the same dialog. */
export function NameDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { participant, setName } = useApp();
  const toast = useToast();
  const [name, setNameState] = useState(participant?.name ?? '');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onClose={onClose} title="How should we call you?">
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await setName(name.trim());
            toast('Saved', 'success');
            onClose();
          } catch (error) {
            toast(error instanceof Error ? error.message : 'Could not save', 'danger');
          } finally {
            setBusy(false);
          }
        }}
      >
        <TextField
          name="displayName"
          label="Display name"
          value={name}
          onChange={(e) => setNameState(e.target.value)}
          maxLength={60}
          autoFocus
          hint="Shown to the expert and to anyone you invite to a room."
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={busy} disabled={!name.trim()}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
