import Alpine from 'alpinejs';
import PocketBase from 'pocketbase';
import { registerSW } from 'virtual:pwa-register';
import './style.css';

registerSW({ immediate: true });

const LOCAL_KEY_PREFIX = 'splitbene.local.v2';
const DEFAULT_STATE = {
  groups: [],
  memberships: [],
  members: [],
  expenses: [],
  tombstones: {
    groups: [],
    memberships: [],
    members: [],
    expenses: [],
  },
};

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const today = () => new Date().toISOString().slice(0, 10);
const nowLocalDateTime = () => {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const toDateTimeLocal = (value) => {
  if (!value) return nowLocalDateTime();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00`;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return nowLocalDateTime();
  const pad = (part) => String(part).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
};
const round = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const clone = (obj) => JSON.parse(JSON.stringify(obj));
const COLLECTIONS_ERROR_MESSAGE =
  'PocketBase is missing required app collections such as group_memberships. Create the collections from README.md, then reload.';
const formatSyncError = (error) => {
  const status = error?.status ? `Sync failed (${error.status})` : 'Sync failed';
  const message = error?.response?.message || error?.message || 'Unknown PocketBase error.';
  return `${status}: ${message}`;
};

function localStorageKey(userId) {
  return `${LOCAL_KEY_PREFIX}.${userId || 'guest'}`;
}

function normalizeExpenseSplits(expense) {
  return Array.isArray(expense.splits) ? expense.splits : [];
}

window.splitbeneApp = function splitbeneApp() {
  return {
    debugEnabled: localStorage.getItem('splitbene.debug') === '1',
    pocketbaseUrl: localStorage.getItem('splitbene.pbUrl') || import.meta.env.VITE_POCKETBASE_URL || '',
    pb: null,
    online: navigator.onLine,
    showSettings: false,
    tab: 'expenses',

    authReady: false,
    authMode: 'login',
    authError: '',
    authLoading: false,
    authUser: null,
    inviteGroupRemoteId: new URLSearchParams(window.location.search).get('inviteGroup') || '',

    loginForm: {
      email: '',
      password: '',
    },
    registerForm: {
      name: '',
      email: '',
      password: '',
      passwordConfirm: '',
    },

    selectedGroupId: null,
    groups: [],
    memberships: [],
    members: [],
    expenses: [],
    tombstones: clone(DEFAULT_STATE.tombstones),

    syncing: false,
    syncQueued: false,
    syncBlocked: false,
    authStateInFlight: false,
    authRefreshInFlight: false,

    groupForm: { open: false, id: null, name: '' },
    memberForm: { id: null, name: '', email: '', isOffline: false },
    expenseForm: {
      id: null,
      description: '',
      amount: 0,
      paidBy: '',
      date: nowLocalDateTime(),
      splitMode: 'equal',
      splits: [],
    },

    debug(event, details = {}) {
      if (!this.debugEnabled) return;
      const snapshot = {
        event,
        at: new Date().toISOString(),
        authReady: this.authReady,
        isAuthenticated: this.isAuthenticated,
        syncing: this.syncing,
        syncQueued: this.syncQueued,
        groupFormOpen: this.groupForm.open,
        selectedGroupId: this.selectedGroupId,
        groupCount: this.groups.length,
        visibleGroupCount: this.groupsVisible.length,
        ...details,
      };
      console.log('[Splitbene debug]', snapshot);
      window.__splitbeneDebugLog = window.__splitbeneDebugLog || [];
      window.__splitbeneDebugLog.push(snapshot);
    },

    setDebugEnabled(enabled) {
      this.debugEnabled = !!enabled;
      localStorage.setItem('splitbene.debug', enabled ? '1' : '0');
      this.debug('debug-mode-changed', { enabled: this.debugEnabled });
    },

    init() {
      window.splitbeneDebug = {
        enable: () => this.setDebugEnabled(true),
        disable: () => this.setDebugEnabled(false),
        dump: () => window.__splitbeneDebugLog || [],
      };
      this.debug('init');
      window.addEventListener('online', () => {
        this.online = true;
        this.debug('browser-online');
        if (this.isAuthenticated) this.syncNow();
      });
      window.addEventListener('offline', () => {
        this.online = false;
        this.debug('browser-offline');
      });
      this.online = navigator.onLine;
      this.setupPocketBase();
    },

    get isAuthenticated() {
      return !!this.authUser;
    },

    get localKey() {
      return localStorageKey(this.authUser?.id);
    },

    setupPocketBase() {
      if (!this.pocketbaseUrl) {
        this.pb = null;
        this.authReady = true;
        this.authError = 'Set PocketBase URL to use authentication.';
        this.debug('setup-pocketbase-missing-url');
        return;
      }

      this.pb = new PocketBase(this.pocketbaseUrl);
      this.pb.authStore.onChange(() => {
        this.debug('authstore-change', {
          authStoreValid: this.pb?.authStore?.isValid,
          authStoreRecordId: this.pb?.authStore?.record?.id || null,
        });
        this.authUser = this.pb?.authStore?.record || null;
        if (this.authStateInFlight || this.authRefreshInFlight) return;
        this.handleAuthState();
      }, true);
      this.handleAuthState();
    },

    async handleAuthState() {
      if (this.authStateInFlight) return;
      this.authStateInFlight = true;
      this.debug('handle-auth-state-start', {
        authStoreValid: this.pb?.authStore?.isValid,
        authStoreRecordId: this.pb?.authStore?.record?.id || null,
      });
      try {
        if (!this.pb) {
          this.authReady = true;
          this.debug('handle-auth-state-no-pb');
          return;
        }

        if (this.pb.authStore.isValid) {
          this.authUser = this.pb.authStore.record;
          this.authError = '';
          this.syncBlocked = false;
          this.loadLocal();
          if (this.online) {
            try {
              this.authRefreshInFlight = true;
              await this.pb.collection('users').authRefresh();
              this.authUser = this.pb.authStore.record;
              this.debug('auth-refresh-success', { authUserId: this.authUser?.id || null });
            } catch (_e) {
            } finally {
              this.authRefreshInFlight = false;
            }
            await this.acceptInviteIfPresent();
            await this.syncNow();
          }
        } else {
          this.authUser = null;
          this.syncBlocked = false;
          this.resetData();
        }
        this.authReady = true;
        this.debug('handle-auth-state-end', { authUserId: this.authUser?.id || null });
      } finally {
        this.authStateInFlight = false;
      }
    },

    savePocketbaseUrl() {
      const clean = (this.pocketbaseUrl || '').trim().replace(/\/$/, '');
      this.pocketbaseUrl = clean;
      localStorage.setItem('splitbene.pbUrl', clean);
      this.setupPocketBase();
    },

    resetData() {
      this.debug('reset-data');
      this.groups = [];
      this.memberships = [];
      this.members = [];
      this.expenses = [];
      this.tombstones = clone(DEFAULT_STATE.tombstones);
      this.selectedGroupId = null;
      this.groupForm = { open: false, id: null, name: '' };
      this.memberForm = { id: null, name: '', email: '', isOffline: false };
      this.expenseForm = {
        id: null,
        description: '',
        amount: 0,
        paidBy: '',
        date: nowLocalDateTime(),
        splitMode: 'equal',
        splits: [],
      };
    },

    loadLocal() {
      const raw = localStorage.getItem(this.localKey);
      if (!raw) {
        this.debug('load-local-empty', { localKey: this.localKey });
        this.resetData();
        return;
      }
      const data = JSON.parse(raw);
      this.groups = data.groups || [];
      this.memberships = data.memberships || [];
      this.members = data.members || [];
      this.expenses = data.expenses || [];
      this.tombstones = data.tombstones || clone(DEFAULT_STATE.tombstones);
      this.selectedGroupId = data.selectedGroupId || this.selectedGroupId;
      if (this.selectedGroupId && !this.currentGroup) {
        this.selectedGroupId = this.groupsVisible[0]?.id || null;
      }
      if (!this.expenseForm.id) this.resetExpenseForm();
      this.debug('load-local-success', {
        localKey: this.localKey,
        loadedGroups: this.groups.length,
        loadedMemberships: this.memberships.length,
        loadedMembers: this.members.length,
        loadedExpenses: this.expenses.length,
      });
    },

    persistLocal() {
      if (!this.isAuthenticated) return;
      localStorage.setItem(
        this.localKey,
        JSON.stringify({
          groups: this.groups,
          memberships: this.memberships,
          members: this.members,
          expenses: this.expenses,
          tombstones: this.tombstones,
          selectedGroupId: this.selectedGroupId,
        }),
      );
    },

    async register() {
      if (!this.pb) return;
      this.authLoading = true;
      this.authError = '';
      try {
        await this.pb.collection('users').create({
          name: (this.registerForm.name || '').trim(),
          email: (this.registerForm.email || '').trim(),
          password: this.registerForm.password,
          passwordConfirm: this.registerForm.passwordConfirm,
        });
        await this.pb.collection('users').authWithPassword(this.registerForm.email.trim(), this.registerForm.password);
        this.registerForm = { name: '', email: '', password: '', passwordConfirm: '' };
      } catch (e) {
        this.authError = e?.message || 'Registration failed.';
      } finally {
        this.authLoading = false;
      }
    },

    async login() {
      if (!this.pb) return;
      this.authLoading = true;
      this.authError = '';
      this.debug('login-start', { email: this.loginForm.email.trim() });
      try {
        await this.pb.collection('users').authWithPassword(this.loginForm.email.trim(), this.loginForm.password);
        this.loginForm.password = '';
        this.debug('login-success');
      } catch (e) {
        this.authError = e?.message || 'Login failed.';
        this.debug('login-error', { message: this.authError });
      } finally {
        this.authLoading = false;
      }
    },

    logout() {
      if (!this.pb) return;
      this.pb.authStore.clear();
      this.authMode = 'login';
    },

    async acceptInviteIfPresent() {
      if (!this.inviteGroupRemoteId || !this.pb || !this.isAuthenticated || !this.online) return;
      try {
        const existing = await this.pb
          .collection('group_memberships')
          .getFirstListItem(`group = "${this.inviteGroupRemoteId}" && user = "${this.authUser.id}"`)
          .catch(() => null);

        if (!existing) {
          await this.pb.collection('group_memberships').create({
            group: this.inviteGroupRemoteId,
            user: this.authUser.id,
            role: 'member',
            local_id: uid(),
            updated_at_client: Date.now(),
          });
          alert('You joined the group from the invite link.');
        }

        const url = new URL(window.location.href);
        url.searchParams.delete('inviteGroup');
        window.history.replaceState({}, '', url.toString());
        this.inviteGroupRemoteId = '';
      } catch (e) {
        console.error('Invite join failed', e);
      }
    },

    markDirty(record) {
      record.updatedAtClient = Date.now();
      record.dirty = true;
    },

    currentUserMembership(groupId) {
      return this.memberships.find((m) => m.groupId === groupId && m.userId === this.authUser?.id) || null;
    },

    groupMemberships(groupId) {
      return this.memberships.filter((m) => m.groupId === groupId);
    },

    get groupsVisible() {
      return this.groups
        .filter((g) => !!this.currentUserMembership(g.id))
        .map((g) => ({
          ...g,
          memberCount: this.members.filter((m) => m.groupId === g.id).length,
          expenseCount: this.expenses.filter((e) => e.groupId === g.id).length,
        }))
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    },

    get currentGroup() {
      const group = this.groups.find((g) => g.id === this.selectedGroupId) || null;
      if (!group) return null;
      if (!this.currentUserMembership(group.id)) return null;
      return group;
    },

    selectGroup(id) {
      if (!this.currentUserMembership(id)) return;
      this.selectedGroupId = id;
      this.tab = 'expenses';
      this.resetMemberForm();
      this.resetExpenseForm();
      this.persistLocal();
    },

    startGroupCreate() {
      this.debug('group-form-open-create');
      this.groupForm = { open: true, id: null, name: '' };
    },

    startGroupEdit(id) {
      const group = this.groups.find((g) => g.id === id);
      if (!group || !this.currentUserMembership(id)) return;
      this.debug('group-form-open-edit', { id });
      this.groupForm = { open: true, id: group.id, name: group.name };
    },

    cancelGroupForm() {
      this.debug('group-form-cancel');
      this.groupForm = { open: false, id: null, name: '' };
    },

    ensureCurrentUserMemberProfile(groupId, defaultName) {
      const existing = this.members.find((m) => m.groupId === groupId && m.authUserId === this.authUser?.id);
      if (existing) return existing;
      const member = {
        id: uid(),
        remoteId: null,
        groupId,
        authUserId: this.authUser?.id || '',
        name: defaultName || this.authUser?.name || this.authUser?.email || 'You',
        email: this.authUser?.email || '',
        isOffline: false,
        invited: true,
        dirty: true,
        createdAtClient: Date.now(),
        updatedAtClient: Date.now(),
      };
      this.members.push(member);
      return member;
    },

    canonicalMemberKey(member) {
      if (member?.authUserId) return `auth:${member.groupId}:${member.authUserId}`;
      return `member:${member?.id || ''}`;
    },

    membersForGroup(groupId) {
      return this.members
        .filter((m) => m.groupId === groupId)
        .sort((a, b) => {
          const aRemote = a.remoteId ? 0 : 1;
          const bRemote = b.remoteId ? 0 : 1;
          if (aRemote !== bRemote) return aRemote - bRemote;
          return (a.createdAtClient || 0) - (b.createdAtClient || 0);
        });
    },

    uniqueMembersForGroup(groupId) {
      const seen = new Set();
      const unique = [];
      for (const member of this.membersForGroup(groupId)) {
        const key = this.canonicalMemberKey(member);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(member);
      }
      return unique.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    },

    currentUserMemberProfile(groupId = this.currentGroup?.id) {
      if (!groupId) return null;
      return this.uniqueMembersForGroup(groupId).find((m) => m.authUserId === this.authUser?.id) || null;
    },

    saveGroup() {
      this.debug('group-save-start', {
        id: this.groupForm.id,
        name: (this.groupForm.name || '').trim(),
      });
      if (!this.isAuthenticated) return;
      const name = (this.groupForm.name || '').trim();
      if (!name) return;

      if (this.groupForm.id) {
        const group = this.groups.find((g) => g.id === this.groupForm.id);
        if (!group || !this.currentUserMembership(group.id)) return;
        group.name = name;
        this.markDirty(group);
      } else {
        const group = {
          id: uid(),
          remoteId: null,
          name,
          createdByUserId: this.authUser.id,
          dirty: true,
          createdAtClient: Date.now(),
          updatedAtClient: Date.now(),
        };
        this.groups.push(group);

        this.memberships.push({
          id: uid(),
          remoteId: null,
          groupId: group.id,
          userId: this.authUser.id,
          role: 'owner',
          dirty: true,
          createdAtClient: Date.now(),
          updatedAtClient: Date.now(),
        });

        this.ensureCurrentUserMemberProfile(group.id, this.authUser.name || this.authUser.email);
        this.selectedGroupId = group.id;
      }

      this.cancelGroupForm();
      this.persistLocal();
      this.syncNow();
      this.debug('group-save-finished', { selectedGroupId: this.selectedGroupId });
    },

    deleteGroup(id) {
      if (!confirm('Delete this group and all its data?')) return;
      const group = this.groups.find((g) => g.id === id);
      if (!group || !this.currentUserMembership(id)) return;

      const membersInGroup = this.members.filter((m) => m.groupId === id);
      const membershipsInGroup = this.memberships.filter((m) => m.groupId === id);
      const expensesInGroup = this.expenses.filter((e) => e.groupId === id);

      const memberRemoteIds = membersInGroup.map((m) => m.remoteId).filter(Boolean);
      const membershipRemoteIds = membershipsInGroup.map((m) => m.remoteId).filter(Boolean);
      const expenseRemoteIds = expensesInGroup.map((e) => e.remoteId).filter(Boolean);

      this.members = this.members.filter((m) => m.groupId !== id);
      this.memberships = this.memberships.filter((m) => m.groupId !== id);
      this.expenses = this.expenses.filter((e) => e.groupId !== id);
      this.groups = this.groups.filter((g) => g.id !== id);

      if (group.remoteId) this.tombstones.groups.push(group.remoteId);
      this.tombstones.members.push(...memberRemoteIds);
      this.tombstones.memberships.push(...membershipRemoteIds);
      this.tombstones.expenses.push(...expenseRemoteIds);

      if (this.selectedGroupId === id) {
        this.selectedGroupId = this.groupsVisible[0]?.id || null;
      }
      this.persistLocal();
      this.syncNow();
    },

    get groupMembers() {
      if (!this.currentGroup) return [];
      return this.uniqueMembersForGroup(this.currentGroup.id);
    },

    resetMemberForm() {
      this.memberForm = { id: null, name: '', email: '', isOffline: false };
    },

    saveMember() {
      if (!this.currentGroup) return;
      const email = (this.memberForm.email || '').trim();
      const typedName = (this.memberForm.name || '').trim();
      const name = typedName || (!this.memberForm.isOffline ? email : '');
      if (!name) {
        alert('Enter a name, or enter an email for a registered user.');
        return;
      }

      if (this.memberForm.id) {
        const member = this.members.find((m) => m.id === this.memberForm.id);
        if (!member) return;
        member.name = name;
        member.email = email;
        member.isOffline = !!this.memberForm.isOffline;
        if (!member.isOffline && !member.authUserId) {
          member.invited = !!email;
        }
        this.markDirty(member);
      } else {
        this.members.push({
          id: uid(),
          remoteId: null,
          groupId: this.currentGroup.id,
          authUserId: '',
          name,
          email,
          isOffline: !!this.memberForm.isOffline,
          invited: !this.memberForm.isOffline && !!email,
          dirty: true,
          createdAtClient: Date.now(),
          updatedAtClient: Date.now(),
        });
      }

      this.resetMemberForm();
      this.persistLocal();
      this.syncNow();
    },

    startMemberEdit(id) {
      const member = this.members.find((m) => m.id === id);
      if (!member) return;
      this.memberForm = {
        id: member.id,
        name: member.name,
        email: member.email || '',
        isOffline: !!member.isOffline,
      };
      this.tab = 'users';
    },

    deleteMember(id) {
      if (!confirm('Remove this member from group?')) return;
      const member = this.members.find((m) => m.id === id);
      if (!member) return;
      if (member.authUserId === this.authUser?.id) {
        alert('You cannot remove your own linked member profile.');
        return;
      }

      const relatedMembers = member.authUserId
        ? this.members.filter((m) => m.groupId === member.groupId && m.authUserId === member.authUserId)
        : [member];
      const relatedMemberIds = new Set(relatedMembers.map((m) => m.id));
      const expensesUsingMember = this.expenses.filter(
        (e) =>
          e.groupId === member.groupId &&
          (relatedMemberIds.has(e.paidBy) || (e.splits || []).some((s) => relatedMemberIds.has(s.memberId))),
      );
      if (expensesUsingMember.length > 0) {
        alert('This member is used in expenses. Edit or remove those expenses first.');
        return;
      }

      this.members = this.members.filter((m) => !relatedMemberIds.has(m.id));
      this.tombstones.members.push(...relatedMembers.map((m) => m.remoteId).filter(Boolean));
      if (member.authUserId) {
        const relatedMemberships = this.memberships.filter(
          (m) => m.groupId === member.groupId && m.userId === member.authUserId,
        );
        const relatedMembershipIds = new Set(relatedMemberships.map((m) => m.id));
        this.memberships = this.memberships.filter((m) => !relatedMembershipIds.has(m.id));
        this.tombstones.memberships.push(...relatedMemberships.map((m) => m.remoteId).filter(Boolean));
      }
      this.persistLocal();
      this.syncNow();
    },

    resetExpenseForm() {
      const splits = this.groupMembers.map((m) => ({ memberId: m.id, value: 0 }));
      const defaultPayer = this.currentUserMemberProfile(this.currentGroup?.id)?.id || this.groupMembers[0]?.id || '';
      this.expenseForm = {
        id: null,
        description: '',
        amount: 0,
        paidBy: defaultPayer,
        date: nowLocalDateTime(),
        splitMode: 'equal',
        splits,
      };
    },

    expenseParticipantIncluded(memberId) {
      return (this.expenseForm.splits || []).some((s) => s.memberId === memberId);
    },

    toggleExpenseParticipant(memberId) {
      const idx = (this.expenseForm.splits || []).findIndex((s) => s.memberId === memberId);
      if (idx >= 0) {
        this.expenseForm.splits.splice(idx, 1);
      } else {
        this.expenseForm.splits.push({ memberId, value: 0 });
      }
    },

    expenseParticipantValue(memberId) {
      return (this.expenseForm.splits || []).find((s) => s.memberId === memberId)?.value ?? '';
    },

    setExpenseParticipantValue(memberId, value) {
      const row = (this.expenseForm.splits || []).find((s) => s.memberId === memberId);
      if (!row) return;
      row.value = Number(value || 0);
    },

    saveExpense() {
      if (!this.currentGroup) return;
      const description = (this.expenseForm.description || '').trim();
      const amount = Number(this.expenseForm.amount);
      if (!description || !amount || amount <= 0 || !this.expenseForm.paidBy) return;
      if (!this.groupMembers.find((m) => m.id === this.expenseForm.paidBy)) return;

      const splits = clone(this.expenseForm.splits || []);
      if (splits.length === 0) {
        alert('Select at least one participant.');
        return;
      }

      if (this.expenseForm.splitMode === 'percentage') {
        const totalPct = round(splits.reduce((sum, s) => sum + Number(s.value || 0), 0));
        if (Math.abs(totalPct - 100) > 0.01) {
          alert('Percentages must sum to 100%.');
          return;
        }
      }

      if (this.expenseForm.splitMode === 'amount') {
        const totalAmt = round(splits.reduce((sum, s) => sum + Number(s.value || 0), 0));
        if (Math.abs(totalAmt - amount) > 0.01) {
          alert('Split amounts must equal the total expense amount.');
          return;
        }
      }

      if (this.expenseForm.id) {
        const existing = this.expenses.find((e) => e.id === this.expenseForm.id);
        if (!existing) return;
        existing.description = description;
        existing.amount = round(amount);
        existing.paidBy = this.expenseForm.paidBy;
        existing.date = this.expenseForm.date || nowLocalDateTime();
        existing.splitMode = this.expenseForm.splitMode;
        existing.splits = splits;
        this.markDirty(existing);
      } else {
        this.expenses.push({
          id: uid(),
          remoteId: null,
          groupId: this.currentGroup.id,
          description,
          amount: round(amount),
          paidBy: this.expenseForm.paidBy,
          date: this.expenseForm.date || nowLocalDateTime(),
          splitMode: this.expenseForm.splitMode,
          splits,
          dirty: true,
          createdAtClient: Date.now(),
          updatedAtClient: Date.now(),
        });
      }

      this.resetExpenseForm();
      this.persistLocal();
      this.syncNow();
    },

    startExpenseEdit(id) {
      const expense = this.expenses.find((e) => e.id === id);
      if (!expense) return;
      this.expenseForm = {
        id: expense.id,
        description: expense.description,
        amount: expense.amount,
        paidBy: expense.paidBy,
        date: toDateTimeLocal(expense.date),
        splitMode: expense.splitMode || 'equal',
        splits: clone(normalizeExpenseSplits(expense)),
      };
      this.tab = 'expenses';
    },

    deleteExpense(id) {
      if (!confirm('Delete this expense?')) return;
      const expense = this.expenses.find((e) => e.id === id);
      if (!expense) return;
      this.expenses = this.expenses.filter((e) => e.id !== id);
      if (expense.remoteId) this.tombstones.expenses.push(expense.remoteId);
      this.persistLocal();
      this.syncNow();
    },

    get groupExpensesSorted() {
      if (!this.currentGroup) return [];
      return this.expenses
        .filter((e) => e.groupId === this.currentGroup.id)
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    },

    memberName(id) {
      return this.members.find((m) => m.id === id)?.name || 'Unknown';
    },

    formatMoney(value) {
      return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Number(value || 0));
    },

    formatExpenseDate(value) {
      if (!value) return '';
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) return value;
      return new Intl.DateTimeFormat('en-GB', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(parsed);
    },

    splitModeLabel(mode) {
      if (mode === 'percentage') return 'Split by percentage';
      if (mode === 'amount') return 'Split by amount';
      return 'Equal split';
    },

    expenseSplitSummary(expense) {
      const participants = (expense.splits || []).filter((s) => this.members.some((m) => m.id === s.memberId));
      if (participants.length === 0) return `${this.splitModeLabel(expense.splitMode)}: no participants`;

      const shares = this.splitShares(expense);
      const details = participants.map((participant) => {
        const name = this.memberName(participant.memberId);
        const share = this.formatMoney(shares[participant.memberId] || 0);
        if (expense.splitMode === 'percentage') {
          return `${name} ${Number(participant.value || 0)}% (${share})`;
        }
        return `${name} ${share}`;
      });

      return `${this.splitModeLabel(expense.splitMode)}: ${details.join(' · ')}`;
    },

    splitShares(expense) {
      const participants = (expense.splits || []).filter((s) => this.groupMembers.some((m) => m.id === s.memberId));
      if (participants.length === 0) return {};
      const shares = {};

      if (expense.splitMode === 'percentage') {
        participants.forEach((p) => {
          shares[p.memberId] = round((expense.amount * Number(p.value || 0)) / 100);
        });
        return shares;
      }

      if (expense.splitMode === 'amount') {
        participants.forEach((p) => {
          shares[p.memberId] = round(Number(p.value || 0));
        });
        return shares;
      }

      const equalShare = round(expense.amount / participants.length);
      let running = 0;
      participants.forEach((p, idx) => {
        if (idx === participants.length - 1) {
          shares[p.memberId] = round(expense.amount - running);
        } else {
          shares[p.memberId] = equalShare;
          running = round(running + equalShare);
        }
      });
      return shares;
    },

    get balanceLines() {
      if (!this.currentGroup) return [];
      const map = new Map(this.groupMembers.map((m) => [m.id, 0]));
      for (const expense of this.groupExpensesSorted) {
        if (!map.has(expense.paidBy)) continue;
        map.set(expense.paidBy, round(map.get(expense.paidBy) + Number(expense.amount || 0)));
        const shares = this.splitShares(expense);
        for (const [memberId, share] of Object.entries(shares)) {
          if (!map.has(memberId)) continue;
          map.set(memberId, round(map.get(memberId) - Number(share || 0)));
        }
      }
      return Array.from(map.entries())
        .map(([memberId, net]) => ({ memberId, name: this.memberName(memberId), net: round(net) }))
        .sort((a, b) => b.net - a.net);
    },

    get settlements() {
      const creditors = this.balanceLines.filter((b) => b.net > 0.01).map((b) => ({ id: b.memberId, amount: b.net }));
      const debtors = this.balanceLines.filter((b) => b.net < -0.01).map((b) => ({ id: b.memberId, amount: -b.net }));
      const transactions = [];

      let i = 0;
      let j = 0;
      while (i < debtors.length && j < creditors.length) {
        const pay = round(Math.min(debtors[i].amount, creditors[j].amount));
        if (pay > 0) transactions.push({ from: debtors[i].id, to: creditors[j].id, amount: pay });
        debtors[i].amount = round(debtors[i].amount - pay);
        creditors[j].amount = round(creditors[j].amount - pay);
        if (debtors[i].amount <= 0.01) i += 1;
        if (creditors[j].amount <= 0.01) j += 1;
      }
      return transactions;
    },

    async shareInvite() {
      if (!this.currentGroup || !this.online) {
        alert('You need to be online to share invite links.');
        return;
      }
      if (!this.currentGroup.remoteId) {
        await this.syncNow(true);
      }
      if (!this.currentGroup.remoteId) {
        alert(this.authError || 'This group has not synced to PocketBase yet. Try Sync Now, then try again.');
        return;
      }

      const link = `${window.location.origin}/?inviteGroup=${encodeURIComponent(this.currentGroup.remoteId)}`;
      navigator.clipboard.writeText(link).then(() => {
        alert('Invite link copied. New users can register, log in, then join from this link.');
      });
    },

    async syncNow(force = false) {
      if (!this.pb || !this.online || !this.isAuthenticated) return;
      if (this.syncBlocked && !force) return;
      if (this.syncing) {
        this.syncQueued = true;
        this.debug('sync-queued');
        return;
      }
      this.syncing = true;
      this.syncQueued = false;
      if (force) {
        this.syncBlocked = false;
        if (this.authError === COLLECTIONS_ERROR_MESSAGE) this.authError = '';
      }
      this.debug('sync-start');
      try {
        await this.pushGroups();
        await this.pushMemberships();
        await this.pushMembers();
        await this.pushExpenses();
        await this.pushTombstones();
        const needsMemberProfileSync = await this.pullAll();
        if (needsMemberProfileSync) {
          await this.pushMembers();
          await this.pullAll();
        }
        this.persistLocal();
        this.syncBlocked = false;
        if (this.authError === COLLECTIONS_ERROR_MESSAGE) this.authError = '';
      } catch (e) {
        console.error('Sync failed', e);
        if (e?.status === 404 && String(e?.message || '').includes('Missing collection context')) {
          this.syncBlocked = true;
          this.showSettings = true;
          this.authError = COLLECTIONS_ERROR_MESSAGE;
        } else {
          this.showSettings = true;
          this.authError = formatSyncError(e);
        }
        this.debug('sync-error', { message: e?.message || String(e) });
      } finally {
        this.syncing = false;
        this.debug('sync-end');
        if (this.syncQueued) {
          this.syncQueued = false;
          setTimeout(() => this.syncNow(), 0);
        }
      }
    },

    async pushGroups() {
      const dirtyGroups = this.groups.filter((g) => g.dirty);
      for (const group of dirtyGroups) {
        const payload = {
          name: group.name,
          created_by: group.createdByUserId || this.authUser.id,
          local_id: group.id,
          updated_at_client: group.updatedAtClient,
        };
        if (group.remoteId) {
          const updated = await this.pb.collection('groups').update(group.remoteId, payload);
          group.remoteId = updated.id;
        } else {
          const created = await this.pb.collection('groups').create(payload);
          group.remoteId = created.id;
        }
        group.dirty = false;
      }
    },

    async pushMemberships() {
      const dirty = this.memberships.filter((m) => m.dirty);
      for (const item of dirty) {
        const group = this.groups.find((g) => g.id === item.groupId);
        if (!group?.remoteId) continue;
        const payload = {
          group: group.remoteId,
          user: item.userId,
          role: item.role || 'member',
          local_id: item.id,
          updated_at_client: item.updatedAtClient,
        };
        if (item.remoteId) {
          const updated = await this.pb.collection('group_memberships').update(item.remoteId, payload);
          item.remoteId = updated.id;
        } else {
          const created = await this.pb.collection('group_memberships').create(payload);
          item.remoteId = created.id;
        }
        item.dirty = false;
      }
    },

    async pushMembers() {
      const dirtyMembers = this.members.filter((m) => m.dirty);
      for (const member of dirtyMembers) {
        const group = this.groups.find((g) => g.id === member.groupId);
        if (!group?.remoteId) continue;
        const payload = {
          group: group.remoteId,
          auth_user: member.authUserId || null,
          name: member.name,
          email: member.email || '',
          is_offline: !!member.isOffline,
          invited: !!member.invited,
          local_id: member.id,
          updated_at_client: member.updatedAtClient,
        };
        if (member.remoteId) {
          const updated = await this.pb.collection('members').update(member.remoteId, payload);
          member.remoteId = updated.id;
        } else {
          const created = await this.pb.collection('members').create(payload);
          member.remoteId = created.id;
        }
        member.dirty = false;
      }
    },

    async pushExpenses() {
      const dirtyExpenses = this.expenses.filter((e) => e.dirty);
      for (const expense of dirtyExpenses) {
        const group = this.groups.find((g) => g.id === expense.groupId);
        const payer = this.members.find((m) => m.id === expense.paidBy);
        if (!group?.remoteId || !payer?.remoteId) continue;

        const resolvedSplits = (expense.splits || [])
          .map((s) => {
            const member = this.members.find((m) => m.id === s.memberId);
            if (!member?.remoteId) return null;
            return { member_remote_id: member.remoteId, member_local_id: member.id, value: Number(s.value || 0) };
          })
          .filter(Boolean);

        const payload = {
          group: group.remoteId,
          paid_by: payer.remoteId,
          description: expense.description,
          amount: Number(expense.amount),
          date: expense.date,
          split_mode: expense.splitMode,
          splits: resolvedSplits,
          local_id: expense.id,
          updated_at_client_number: expense.updatedAtClient,
        };

        if (expense.remoteId) {
          const updated = await this.pb.collection('expenses').update(expense.remoteId, payload);
          expense.remoteId = updated.id;
        } else {
          const created = await this.pb.collection('expenses').create(payload);
          expense.remoteId = created.id;
        }
        expense.dirty = false;
      }
    },

    async pushTombstones() {
      for (const rid of this.tombstones.expenses) {
        try {
          await this.pb.collection('expenses').delete(rid);
        } catch (_e) {}
      }
      for (const rid of this.tombstones.members) {
        try {
          await this.pb.collection('members').delete(rid);
        } catch (_e) {}
      }
      for (const rid of this.tombstones.memberships) {
        try {
          await this.pb.collection('group_memberships').delete(rid);
        } catch (_e) {}
      }
      for (const rid of this.tombstones.groups) {
        try {
          await this.pb.collection('groups').delete(rid);
        } catch (_e) {}
      }
      this.tombstones = clone(DEFAULT_STATE.tombstones);
    },

    async pullAll() {
      if (!this.isAuthenticated) return;
      this.debug('pull-all-start');
      const remoteMemberships = await this.pb
        .collection('group_memberships')
        .getFullList({ filter: `user = "${this.authUser.id}"`, sort: '-updated' });

      const remoteGroupIds = new Set(remoteMemberships.map((m) => m.group));
      let remoteGroups = [];
      let remoteMembers = [];
      let remoteExpenses = [];
      if (remoteGroupIds.size > 0) {
        const filterByIds = (ids, field = 'id') => Array.from(ids).map((id) => `${field} = "${id}"`).join(' || ');
        const groupFilter = filterByIds(remoteGroupIds, 'id');
        const memberGroupFilter = filterByIds(remoteGroupIds, 'group');
        [remoteGroups, remoteMembers, remoteExpenses] = await Promise.all([
          this.pb.collection('groups').getFullList({ filter: groupFilter, sort: '-updated' }),
          this.pb.collection('members').getFullList({ filter: `(${memberGroupFilter})`, sort: '-updated', expand: 'auth_user' }),
          this.pb.collection('expenses').getFullList({ filter: `(${memberGroupFilter})`, sort: '-updated' }),
        ]);
      }
      const localGroups = [...this.groups];
      const localMemberships = [...this.memberships];
      const localMembers = [...this.members];
      const localExpenses = [...this.expenses];

      const groupsByRemote = new Map(localGroups.filter((g) => g.remoteId).map((g) => [g.remoteId, g]));
      const nextGroups = [];
      for (const g of remoteGroups) {
        const local = groupsByRemote.get(g.id) || localGroups.find((x) => x.id === g.local_id);
        if (local) {
          local.remoteId = g.id;
          local.name = g.name;
          local.createdByUserId = g.created_by || local.createdByUserId || '';
          local.dirty = false;
          nextGroups.push(local);
        } else {
          nextGroups.push({
            id: g.local_id || uid(),
            remoteId: g.id,
            name: g.name,
            createdByUserId: g.created_by || '',
            dirty: false,
            createdAtClient: Date.now(),
            updatedAtClient: Number(g.updated_at_client || Date.now()),
          });
        }
      }
      const nextGroupIds = new Set(nextGroups.map((g) => g.id));
      const nextGroupRemoteIds = new Set(nextGroups.map((g) => g.remoteId).filter(Boolean));
      for (const group of localGroups) {
        if (!group.dirty) continue;
        if (nextGroupIds.has(group.id)) continue;
        if (group.remoteId && nextGroupRemoteIds.has(group.remoteId)) continue;
        nextGroups.push(group);
        nextGroupIds.add(group.id);
        if (group.remoteId) nextGroupRemoteIds.add(group.remoteId);
      }
      this.groups = nextGroups;

      const groupMap = new Map(this.groups.map((g) => [g.remoteId, g.id]));
      const localGroupIds = new Set(this.groups.map((g) => g.id));
      const localMembershipsByRemote = new Map(localMemberships.filter((m) => m.remoteId).map((m) => [m.remoteId, m]));
      const nextMemberships = [];
      for (const m of remoteMemberships) {
        const groupId = groupMap.get(m.group);
        if (!groupId) continue;
        const local = localMembershipsByRemote.get(m.id) || localMemberships.find((x) => x.id === m.local_id);
        if (local) {
          local.remoteId = m.id;
          local.groupId = groupId;
          local.userId = m.user;
          local.role = m.role || 'member';
          local.dirty = false;
          nextMemberships.push(local);
        } else {
          nextMemberships.push({
            id: m.local_id || uid(),
            remoteId: m.id,
            groupId,
            userId: m.user,
            role: m.role || 'member',
            dirty: false,
            createdAtClient: Date.now(),
            updatedAtClient: Number(m.updated_at_client || Date.now()),
          });
        }
      }
      const nextMembershipIds = new Set(nextMemberships.map((m) => m.id));
      const nextMembershipRemoteIds = new Set(nextMemberships.map((m) => m.remoteId).filter(Boolean));
      for (const membership of localMemberships) {
        if (!membership.dirty) continue;
        if (!localGroupIds.has(membership.groupId)) continue;
        if (nextMembershipIds.has(membership.id)) continue;
        if (membership.remoteId && nextMembershipRemoteIds.has(membership.remoteId)) continue;
        nextMemberships.push(membership);
        nextMembershipIds.add(membership.id);
        if (membership.remoteId) nextMembershipRemoteIds.add(membership.remoteId);
      }
      this.memberships = nextMemberships;

      const membersByRemote = new Map(localMembers.filter((m) => m.remoteId).map((m) => [m.remoteId, m]));
      const canonicalRemoteMembers = [];
      const duplicateRemoteMemberIds = new Map();
      const remoteMembersSorted = [...remoteMembers].sort((a, b) =>
        `${a.created || ''}${a.id}`.localeCompare(`${b.created || ''}${b.id}`),
      );
      const canonicalRemoteMembersByKey = new Map();
      for (const member of remoteMembersSorted) {
        const groupId = groupMap.get(member.group);
        if (!groupId) continue;
        const key = member.auth_user ? `auth:${groupId}:${member.auth_user}` : `remote:${member.id}`;
        const existing = canonicalRemoteMembersByKey.get(key);
        if (existing) {
          duplicateRemoteMemberIds.set(member.id, existing.id);
          continue;
        }
        canonicalRemoteMembersByKey.set(key, member);
        canonicalRemoteMembers.push(member);
      }
      const nextMembers = [];
      for (const m of canonicalRemoteMembers) {
        const groupId = groupMap.get(m.group);
        if (!groupId) continue;
        const local = membersByRemote.get(m.id) || localMembers.find((x) => x.id === m.local_id);
        const mapped = {
          id: local?.id || m.local_id || uid(),
          remoteId: m.id,
          groupId,
          authUserId: m.auth_user || '',
          name: m.name,
          email: m.email || m.expand?.auth_user?.email || '',
          isOffline: !!m.is_offline,
          invited: !!m.invited,
          dirty: false,
          createdAtClient: local?.createdAtClient || Date.now(),
          updatedAtClient: Number(m.updated_at_client || Date.now()),
        };
        nextMembers.push(mapped);
      }
      const nextMemberIds = new Set(nextMembers.map((m) => m.id));
      const nextMemberRemoteIds = new Set(nextMembers.map((m) => m.remoteId).filter(Boolean));
      for (const member of localMembers) {
        if (!member.dirty) continue;
        if (!localGroupIds.has(member.groupId)) continue;
        if (nextMemberIds.has(member.id)) continue;
        if (member.remoteId && nextMemberRemoteIds.has(member.remoteId)) continue;
        nextMembers.push(member);
        nextMemberIds.add(member.id);
        if (member.remoteId) nextMemberRemoteIds.add(member.remoteId);
      }
      this.members = nextMembers;

      let createdMissingCurrentUserProfile = false;
      for (const group of this.groups) {
        const existing = this.currentUserMemberProfile(group.id);
        if (!existing) {
          this.ensureCurrentUserMemberProfile(group.id, this.authUser.name || this.authUser.email);
          createdMissingCurrentUserProfile = true;
        }
      }

      const memberMap = new Map(this.members.map((m) => [m.remoteId, m.id]));
      for (const [duplicateRemoteId, canonicalRemoteId] of duplicateRemoteMemberIds.entries()) {
        const canonicalLocalId = memberMap.get(canonicalRemoteId);
        if (canonicalLocalId) memberMap.set(duplicateRemoteId, canonicalLocalId);
      }
      const expensesByRemote = new Map(localExpenses.filter((e) => e.remoteId).map((e) => [e.remoteId, e]));
      const nextExpenses = [];
      for (const e of remoteExpenses) {
        const groupId = groupMap.get(e.group);
        if (!groupId) continue;
        const localPayer = memberMap.get(e.paid_by);
        if (!localPayer) continue;

        const resolvedSplits = Array.isArray(e.splits)
          ? e.splits
              .map((s) => {
                const localMember = memberMap.get(s.member_remote_id) || s.member_local_id;
                if (!localMember) return null;
                return { memberId: localMember, value: Number(s.value || 0) };
              })
              .filter(Boolean)
          : [];

        const local = expensesByRemote.get(e.id) || localExpenses.find((x) => x.id === e.local_id);
        nextExpenses.push({
          id: local?.id || e.local_id || uid(),
          remoteId: e.id,
          groupId,
          description: e.description,
          amount: Number(e.amount || 0),
          paidBy: localPayer,
          date: toDateTimeLocal(e.date),
          splitMode: e.split_mode || 'equal',
          splits: resolvedSplits,
          dirty: false,
          createdAtClient: local?.createdAtClient || Date.now(),
          updatedAtClient: Number(e.updated_at_client_number || e.updated_at_client || Date.now()),
        });
      }
      const nextExpenseIds = new Set(nextExpenses.map((e) => e.id));
      const nextExpenseRemoteIds = new Set(nextExpenses.map((e) => e.remoteId).filter(Boolean));
      for (const expense of localExpenses) {
        if (!expense.dirty) continue;
        if (!localGroupIds.has(expense.groupId)) continue;
        if (!nextExpenseIds.has(expense.id) && (!expense.remoteId || !nextExpenseRemoteIds.has(expense.remoteId))) {
          nextExpenses.push(expense);
          nextExpenseIds.add(expense.id);
          if (expense.remoteId) nextExpenseRemoteIds.add(expense.remoteId);
        }
      }
      this.expenses = nextExpenses;

      if (this.selectedGroupId && !this.currentGroup) {
        this.selectedGroupId = this.groupsVisible[0]?.id || null;
      }
      if (!this.selectedGroupId && this.groupsVisible.length) {
        this.selectedGroupId = this.groupsVisible[0].id;
      }
      if (!this.expenseForm.id) this.resetExpenseForm();
      this.debug('pull-all-end', {
        remoteMembershipCount: remoteMemberships.length,
        remoteGroupCount: remoteGroups.length,
        remoteMemberCount: remoteMembers.length,
        remoteExpenseCount: remoteExpenses.length,
        finalGroupCount: this.groups.length,
        createdMissingCurrentUserProfile,
        duplicateRemoteMemberCount: duplicateRemoteMemberIds.size,
      });
      return createdMissingCurrentUserProfile;
    },
  };
};

window.Alpine = Alpine;
Alpine.start();
