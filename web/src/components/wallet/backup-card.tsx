import { useRef, useState, type ChangeEvent } from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  downloadWalletDump,
  exportWalletDump,
  importWalletDump,
  parseWalletDump,
  type RestorableDump,
} from "@/lib/coco/wallet-backup"

export function BackupCard() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [pendingDump, setPendingDump] = useState<RestorableDump | null>(null)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)

  const onFileChosen = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return
    setRestoreError(null)
    try {
      setPendingDump(parseWalletDump(JSON.parse(await file.text())))
    } catch (err) {
      setPendingDump(null)
      setRestoreError(
        err instanceof Error ? err.message : "could not read the backup file",
      )
    }
  }

  const download = async () => {
    downloadWalletDump(await exportWalletDump())
  }

  const restore = async () => {
    if (!pendingDump) return
    setRestoring(true)
    try {
      await importWalletDump(pendingDump)
      window.location.reload()
    } catch (err) {
      setRestoring(false)
      setRestoreError(
        err instanceof Error ? err.message : "restoring the backup failed",
      )
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Backup</CardTitle>
        <CardDescription>
          Your money lives only in this browser. Download a fresh backup
          after every transaction — a backup goes stale the moment you
          spend.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        <Button variant="outline" size="sm" onClick={() => void download()}>
          Download backup (JSON)
        </Button>
        <input
          ref={fileRef}
          id="restore-file"
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => void onFileChosen(e)}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => fileRef.current?.click()}
        >
          Restore from backup…
        </Button>
        {restoreError && <p className="text-sm text-destructive">{restoreError}</p>}
        <AlertDialog
          open={pendingDump !== null}
          onOpenChange={(open) => {
            if (!open) setPendingDump(null)
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Replace this wallet with the backup?
              </AlertDialogTitle>
              <AlertDialogDescription>
                Everything currently in this browser's wallet is replaced by
                the backup — balance, history, and in-flight deposits alike.
                This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep current wallet</AlertDialogCancel>
              <AlertDialogAction
                disabled={restoring}
                onClick={(event) => {
                  event.preventDefault()
                  void restore()
                }}
              >
                {restoring ? "Restoring…" : "Restore backup"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  )
}
