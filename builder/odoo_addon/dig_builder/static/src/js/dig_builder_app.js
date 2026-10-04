/** @odoo-module */

import { Component, onMounted, onWillStart, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { jsonrpc } from "@web/core/network/rpc_service";

export class DigBuilderApp extends Component {
    static template = "dig_builder.DigBuilderApp";

    setup() {
        this.state = useState({
            bootstrap: null,
            project: null,
            body: "",
            provider: "openai",
            model: "gpt-4o-mini",
            loading: true,
            sending: false,
            error: null,
            pollCount: 0,
        });
        onWillStart(() => this.loadBootstrap());
        onMounted(() => this.poll());
    }

    async loadBootstrap() {
        try {
            this.state.bootstrap = await jsonrpc("/dig_builder/app/bootstrap", {});
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

    async loadProject(id) {
        this.state.project = await jsonrpc(`/dig_builder/app/project/${id}`, {});
        this.state.provider = this.state.project.provider;
        this.state.model = this.state.project.model;
    }

    async selectProject(id) {
        this.state.error = null;
        this.state.pollCount = 0;
        await this.loadProject(id);
    }

    startNewProject() {
        this.state.project = null;
        this.state.body = "";
        this.state.error = null;
        this.state.pollCount = 0;
    }

    async createProject() {
        if (this.state.sending) return;
        this.state.sending = true;
        this.state.error = null;
        try {
            const result = await jsonrpc("/dig_builder/app/project/create", {
                name: "Nieuw DIG Builder-project",
                description: this.state.body,
                provider: this.state.provider,
                model: this.state.model,
                client_request_id: crypto.randomUUID(),
            });
            this.state.project = result.project;
            this.state.body = "";
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
            const result = await jsonrpc(`/dig_builder/app/project/${this.state.project.id}/message`, {
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

    async poll() {
        const project = this.state.project;
        if (!project?.task || ["succeeded", "failed"].includes(project.task.state)) return;
        if (this.state.pollCount >= 60) {
            this.state.error = "De taak duurt langer dan verwacht. Je kunt later opnieuw laden.";
            return;
        }
        this.state.pollCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
            await this.loadProject(project.id);
            if (this.state.project?.task && !["succeeded", "failed"].includes(this.state.project.task.state)) {
                await this.poll();
            }
        } catch (error) {
            this.state.error = error.message || "De taakstatus kon niet worden geladen.";
        }
    }

    async approve() {
        try {
            this.state.project = await jsonrpc(`/dig_builder/app/project/${this.state.project.id}/approve`, {});
        } catch (error) {
            this.state.error = error.message || "Het voorstel kon niet worden goedgekeurd.";
        }
    }

    async saveSettings() {
        try {
            this.state.project = await jsonrpc(`/dig_builder/app/project/${this.state.project.id}/settings`, {
                provider: this.state.provider,
                model: this.state.model,
            });
        } catch (error) {
            this.state.error = error.message || "De providerinstellingen konden niet worden opgeslagen.";
        }
    }
}

registry.category("actions").add("dig_builder_app", DigBuilderApp);
