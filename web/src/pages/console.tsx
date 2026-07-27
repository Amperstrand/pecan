import { useHashTab } from "@/lib/router"
import { useSnapshot } from "@/lib/snapshot"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PageHeader } from "@/components/layout/page-header"
import { AccessTab } from "@/components/console/access-tab"
import { MintTab } from "@/components/console/mint-tab"
import { OverviewTab } from "@/components/console/overview-tab"
import { UnitsTab } from "@/components/console/units-tab"

const TAB_NAMES = ["overview", "units", "access", "mint"]

export function ConsolePage() {
  const { snapshot } = useSnapshot()
  const [rawTab, setTab] = useHashTab("overview")
  const tab = TAB_NAMES.includes(rawTab) ? rawTab : "overview"

  return (
    <>
      <PageHeader title={snapshot.mint.name} description={snapshot.mint.description} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="w-full max-w-md">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="units">Units</TabsTrigger>
          <TabsTrigger value="access" className="relative">
            Access
            {snapshot.demo_password_active && (
              <span
                className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-foreground"
                aria-label="Demo password active"
              />
            )}
          </TabsTrigger>
          <TabsTrigger value="mint">Mint</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab snapshot={snapshot} />
        </TabsContent>
        <TabsContent value="units">
          <UnitsTab snapshot={snapshot} />
        </TabsContent>
        <TabsContent value="access">
          <AccessTab snapshot={snapshot} />
        </TabsContent>
        <TabsContent value="mint">
          <MintTab snapshot={snapshot} />
        </TabsContent>
      </Tabs>
    </>
  )
}
