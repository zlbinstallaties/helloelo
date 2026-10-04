/** @odoo-module */

import { Component, onMounted, onWillStart, onWillUnmount, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

export class DigBuilderApp extends Component {
    static template = "dig_builder.DigBuilderApp";

    setup() {
        this.state = useState({
            bootstrap: null,
            project: null,
            body: "",
            provider: "openai",
            model: "gpt-4o-mini",
            createRequestId: crypto.randomUUID(),
            loading: true,
            sending: false,
            error: null,
            pollCount: 0,
            selectionVersion: 0,
        });
        this.active = true;
        onWillStart(() => this.loadBootstrap());
        onMounted(() => this.poll());
        onWillUnmount(() => { this.active = false; });
    }

    async loadBootstrap() {
        try {
            this.state.bootstrap = await rpc("/dig_builder/app/bootstrap", {});
            const first = this.state.bootstrap.projects[0];
            if (first) {
                await this.loadProject(first.id);
            }
        } catch (error) {
            this.state.error = error.message || "De Builder kon niet worden geladen.";
        } finally {
            this.state.loading = false;
        }
    }

    async loadProject(id, selectionVersion = null) {
        const project = await rpc(`/dig_builder/app/project/${id}`, {});
        if (this.active && (selectionVersion === null || selectionVersion === this.state.selectionVersion)) {
            this.state.project = project;
            this.state.provider = project.provider;
            this.state.model = project.model;
        }
        return project;
    }

    async selectProject(id) {
        this.state.error = null;
        this.state.pollCount = 0;
        this.state.selectionVersion += 1;
        const selectionVersion = this.state.selectionVersion;
        await this.loadProject(id, selectionVersion);
        if (this.active && selectionVersion === this.state.selectionVersion) await this.poll();
    }

    startNewProject() {
        this.state.project = null;
        this.state.body = "";
        this.state.error = null;
        this.state.pollCount = 0;
        this.state.selectionVersion += 1;
        this.state.createRequestId = crypto.randomUUID();
    }

    async createProject() {
        if (this.state.sending) return;
        this.state.sending = true;
        this.state.error = null;
        try {
            const result = await rpc("/dig_builder/app/project/create", {
                name: "Nieuw DIG Builder-project",
                description: this.state.body,
                provider: this.state.provider,
                model: this.state.model,
                client_request_id: this.state.createRequestId,
            });
            this.state.project = result.project;
            this.state.bootstrap.projects = [
                { id: result.project.id, name: result.project.name, state: result.project.state, phase: result.project.phase },
                ...(this.state.bootstrap.projects || []).filter((project) => project.id !== result.project.id),
            ];
            this.state.body = "";
            this.state.pollCount = 0;
            await this.poll();
        } catch (error) {
            this.state.error = error.message || "Het verzoek kon niet worden verwerkt.";
        } finally {
            this.state.sending = false;
        }
    }

    async sendMessage() {
        if (!this.state.body.trim()) return;
        if (this.state.sending) return;
        if (!this.state.project) return this.createProject();
        this.state.sending = true;
        this.state.error = null;
        try {
            const result = await rpc(`/dig_builder/app/project/${this.state.project.id}/message`, {
                body: this.state.body,
                client_request_id: crypto.randomUUID(),
            });
            this.state.project = result.project;
            this.state.body = "";
            await this.poll();
        } catch (error) {
            this.state.error = error.message || "Het bericht kon niet worden verwerkt.";
        } finally {
            this.state.sending = false;
        }
    }

    handleComposerKeydown(event) {
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            this.sendMessage();
        }
    }

    async poll() {
        const project = this.state.project;
        if (!this.active) return;
        if (!project?.task || ["succeeded", "failed", "stale", "interrupted"].includes(project.task.state)) return;
        if (this.state.pollCount >= 60) {
            this.state.error = "De taak duurt langer dan verwacht. Je kunt later opnieuw laden.";
            return;
        }
        this.state.pollCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
            const version = this.state.selectionVersion;
            const refreshed = await this.loadProject(project.id, version);
            if (!this.active || version !== this.state.selectionVersion || this.state.project?.id !== project.id) return;
            this.state.project = refreshed;
            if (this.state.project?.task && !["succeeded", "failed", "stale", "interrupted"].includes(this.state.project.task.state)) {
                await this.poll();
            }
        } catch (error) {
            this.state.error = error.message || "De taakstatus kon niet worden geladen.";
        }
    }

    async approve() {
        try {
            this.state.project = await rpc(`/dig_builder/app/project/${this.state.project.id}/approve`, {});
        } catch (error) {
            this.state.error = error.message || "Het voorstel kon niet worden goedgekeurd.";
        }
    }

    async saveSettings() {
        try {
            this.state.project = await rpc(`/dig_builder/app/project/${this.state.project.id}/settings`, {
                provider: this.state.provider,
                model: this.state.model,
            });
        } catch (error) {
            this.state.error = error.message || "De providerinstellingen konden niet worden opgeslagen.";
        }
    }
}

registry.category("actions").add("dig_builder_app", DigBuilderApp);
