"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { AgentCard } from "@/components/agents/agent-card";
import { AGENT_CONFIG } from "@/lib/constants";
import type { Agent, AgentName } from "@/types/agent";

const INTEGRATIONS = [
  { name: "Elasticsearch", status: "connected" },
  { name: "Slack", status: "connected" },
  { name: "Jira", status: "connected" },
  { name: "PagerDuty", status: "disconnected" },
  { name: "Kubernetes", status: "connected" },
  { name: "GitHub", status: "connected" },
  { name: "Cloudflare", status: "disconnected" },
];

export default function SettingsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [thresholds, setThresholds] = useState({
    suppress: 0.4,
    anomalySigma: 2.0,
    approvalTimeout: 15,
    maxReflection: 3,
  });

  useEffect(() => {
    async function load() {
      const { mockAgents } = await import("@/data/mock/agents");
      setAgents(mockAgents);
    }
    load();
  }, []);

  return (
    <div className="p-4 md:p-6 space-y-4">
      <h1 className="text-lg font-semibold">Settings</h1>

      <Tabs defaultValue="agents">
        <TabsList>
          <TabsTrigger value="agents">Agents</TabsTrigger>
          <TabsTrigger value="thresholds">Thresholds</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
        </TabsList>

        <TabsContent value="agents" className="mt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {agents.map((agent) => (
              <AgentCard key={agent.name} agent={agent} />
            ))}
          </div>
        </TabsContent>

        <TabsContent value="thresholds" className="mt-4 max-w-xl space-y-6">
          <Card>
            <CardContent className="p-6 space-y-6">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm">Suppress Threshold</Label>
                  <span className="text-sm font-mono">{thresholds.suppress.toFixed(2)}</span>
                </div>
                <Slider value={[thresholds.suppress]} min={0} max={1} step={0.05} onValueChange={([v]) => setThresholds({ ...thresholds, suppress: v })} />
                <p className="text-xs text-muted-foreground">Alerts with priority score below this threshold are auto-suppressed.</p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm">Anomaly σ Threshold</Label>
                  <span className="text-sm font-mono">{thresholds.anomalySigma.toFixed(1)}</span>
                </div>
                <Slider value={[thresholds.anomalySigma]} min={1} max={4} step={0.5} onValueChange={([v]) => setThresholds({ ...thresholds, anomalySigma: v })} />
                <p className="text-xs text-muted-foreground">Standard deviations from baseline before Sentinel triggers an alert.</p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm">Approval Timeout (minutes)</Label>
                  <span className="text-sm font-mono">{thresholds.approvalTimeout}</span>
                </div>
                <Slider value={[thresholds.approvalTimeout]} min={5} max={60} step={5} onValueChange={([v]) => setThresholds({ ...thresholds, approvalTimeout: v })} />
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm">Max Reflection Loops</Label>
                  <span className="text-sm font-mono">{thresholds.maxReflection}</span>
                </div>
                <Slider value={[thresholds.maxReflection]} min={1} max={10} step={1} onValueChange={([v]) => setThresholds({ ...thresholds, maxReflection: v })} />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="integrations" className="mt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {INTEGRATIONS.map((int) => (
              <Card key={int.name}>
                <CardContent className="p-4 flex items-center justify-between">
                  <span className="text-sm font-medium">{int.name}</span>
                  <Badge className={int.status === "connected" ? "bg-success/15 text-success" : "bg-error/15 text-error"}>
                    {int.status}
                  </Badge>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="notifications" className="mt-4 max-w-xl">
          <Card>
            <CardContent className="p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm">Critical Escalation Alerts</Label>
                  <p className="text-xs text-muted-foreground">Receive alerts for critical escalations via all channels.</p>
                </div>
                <Switch defaultChecked />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm">Approval Request Notifications</Label>
                  <p className="text-xs text-muted-foreground">Get notified when actions need your approval.</p>
                </div>
                <Switch defaultChecked />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm">Resolution Notifications</Label>
                  <p className="text-xs text-muted-foreground">Notify when incidents are resolved.</p>
                </div>
                <Switch />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm">Sound Alerts</Label>
                  <p className="text-xs text-muted-foreground">Play sound for critical incidents.</p>
                </div>
                <Switch />
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
