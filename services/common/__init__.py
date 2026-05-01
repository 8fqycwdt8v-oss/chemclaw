"""Shared helpers used across Python services.

Currently exposes:
    config_registry — Phase 2 of the configuration concept; scoped key/value
        reader backed by the config_settings Postgres table with a 60s
        in-process cache. Mirror of services/agent-claw/src/config/registry.ts.
"""
