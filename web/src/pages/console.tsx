import { useHashTab } from "@/lib/router"
import { useSnapshot } from "@/lib/snapshot"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PageHeader } from "@/components/layout/page-header"
import { AccessTab } from "@/components/console/access-tab"
import { MintTab } from "@/components/console/mint-tab"
import { OverviewTab } from "@/components/console/overview-tab"

const TAB_NAMES = ["overview", "mint", "access"]

export function ConsolePage() {
  const { snapshot } = useSnapshot()
  const [rawTab, setTab] = useHashTab("overview")
  const isAdmin = snapshot.session.role === "admin"
  const tabs = isAdmin ? TAB_NAMES : ["overview"]
  const tab = tabs.includes(rawTab) ? rawTab : "overview"

  const mintNeedsAttention = snapshot.checklist.some(
    (check) => check.status === "fail" || check.status === "warn",
  )

  return (
    <>
      <PageHeader
        title={snapshot.mint_identity?.name || "Operator console"}
        description={
          snapshot.setup.mint_url ||
          "No mint attached yet — start with the checklist in the Mint tab."
        }
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="w-full max-w-md">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          {isAdmin && (
            <TabsTrigger value="mint" className="relative">
              Mint
              {mintNeedsAttention && (
                <span
                  className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-foreground"
                  aria-label="Mint attachment needs attention"
                />
              )}
            </TabsTrigger>
          )}
          {isAdmin && (
            <TabsTrigger value="access" className="relative">
              Access
              {snapshot.demo_password_active && (
                <span
                  className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-foreground"
                  aria-label="Demo password active"
                />
              )}
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab snapshot={snapshot} />
        </TabsContent>
        {isAdmin && (
          <TabsContent value="mint">
            <MintTab snapshot={snapshot} />
          </TabsContent>
        )}
        {isAdmin && (
          <TabsContent value="access">
            <AccessTab snapshot={snapshot} />
          </TabsContent>
        )}
      </Tabs>
    </>
  )
}
