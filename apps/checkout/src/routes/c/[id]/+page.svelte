<script lang="ts">
	import type { PageData } from './$types';
	import type { CheckoutSessionData, PaymentMethod } from '../../../lib/types';
	import { choosePaymentMethod, submitPaymentDetails } from '../../../lib/api';

	let { data }: { data: PageData } = $props();

	// Session state initialized from SvelteKit load
	let session = $state<CheckoutSessionData | null>(null);
	let loadError = $state<string | null>(null);

	// User input state
	let selectedMethod = $state<PaymentMethod | null>(null);
	let senderNumber = $state('');
	let trxId = $state('');
	let honeypot = $state('');

	$effect(() => {
		session = data.session;
		loadError = data.error;
		if (data.session?.method) {
			selectedMethod = data.session.method;
		}
	});

	// UI feedback state
	let isSubmitting = $state(false);
	let errorMessage = $state<string | null>(null);
	let copiedField = $state<'number' | 'amount' | null>(null);
	let redirectCountdown = $state(3);
	let submittedRedirectUrl = $state<string | null>(null);

	// Derived brand color & name
	let brandColor = $derived(session?.store?.brand_color || '#10B981');
	let storeName = $derived(session?.store?.name || 'Store');
	let isBkash = $derived(selectedMethod === 'bkash');
	let trxLabel = $derived(isBkash ? 'TrxID' : 'TxnID');

	let bkashEnabled = $derived(session?.available_methods.includes('bkash') ?? false);
	let nagadEnabled = $derived(session?.available_methods.includes('nagad') ?? false);
	let codEnabled = $derived(session?.available_methods.includes('cod') ?? false);

	// Copy to clipboard helper
	async function copyToClipboard(text: string, field: 'number' | 'amount') {
		try {
			await navigator.clipboard.writeText(text);
			copiedField = field;
			setTimeout(() => {
				if (copiedField === field) copiedField = null;
			}, 2000);
		} catch {
			// Fallback if clipboard API is restricted
			const textarea = document.createElement('textarea');
			textarea.value = text;
			document.body.appendChild(textarea);
			textarea.select();
			document.execCommand('copy');
			document.body.removeChild(textarea);
			copiedField = field;
			setTimeout(() => {
				if (copiedField === field) copiedField = null;
			}, 2000);
		}
	}

	// Handle method selection
	async function handleSelectMethod(method: PaymentMethod) {
		if (!session) return;
		errorMessage = null;
		isSubmitting = true;

		try {
			const res = await choosePaymentMethod(session.id, method);
			selectedMethod = method;

			if (method === 'cod') {
				session.status = 'CONFIRMED';
				session.method = 'cod';
				const targetUrl = res.redirect_url || session.success_url;
				submittedRedirectUrl = targetUrl;
				startRedirectTimer(targetUrl);
			} else {
				session.method = method;
				session.assigned_wallet = res.assigned_wallet;
			}
		} catch (err: any) {
			errorMessage = err.message || 'Failed to select method';
		} finally {
			isSubmitting = false;
		}
	}

	// Handle TrxID form submission
	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (!session || isSubmitting) return;

		errorMessage = null;

		// Client-side phone validation
		const cleanPhone = senderNumber.trim();
		if (!/^01[3-9]\d{8}$/.test(cleanPhone)) {
			errorMessage = 'Please enter a valid 11-digit Bangladeshi phone number (013-019).';
			return;
		}

		// Client-side TrxID validation
		const cleanTrx = trxId.replace(/\s+/g, '').toUpperCase();
		if (!/^[A-Z0-9]{6,30}$/.test(cleanTrx)) {
			errorMessage = `Please enter a valid ${trxLabel} (6-30 alphanumeric characters).`;
			return;
		}

		isSubmitting = true;

		try {
			const res = await submitPaymentDetails(session.id, {
				sender_number: cleanPhone,
				trx_id: cleanTrx,
				honeypot: honeypot.trim(),
			});

			session.status = 'SUBMITTED';
			session.trx_id = cleanTrx;
			session.sender_number = cleanPhone;
			session.attempts_remaining = res.attempts_remaining;

			submittedRedirectUrl = res.redirect_url;
			startRedirectTimer(res.redirect_url);
		} catch (err: any) {
			errorMessage = err.message || 'Failed to submit payment details';
		} finally {
			isSubmitting = false;
		}
	}

	// 3-second automatic redirect countdown
	function startRedirectTimer(url: string) {
		redirectCountdown = 3;
		const interval = setInterval(() => {
			redirectCountdown -= 1;
			if (redirectCountdown <= 0) {
				clearInterval(interval);
				window.location.href = url;
			}
		}, 1000);
	}
</script>

<svelte:head>
	<title>{session ? `${storeName} Checkout · ৳${session.amount.toLocaleString('en-BD')}` : 'Checkout · SMPG'}</title>
</svelte:head>

<div class="min-h-screen bg-slate-50 flex flex-col justify-between text-slate-800 antialiased selection:bg-rose-500 selection:text-white pb-12">
	<!-- Top App Bar -->
	<header class="w-full bg-white border-b border-slate-200 shadow-xs py-4 px-6 sticky top-0 z-20">
		<div class="max-w-md mx-auto flex items-center justify-between">
			<div class="flex items-center gap-3">
				<div
					class="w-10 h-10 rounded-full flex items-center justify-center font-bold text-white text-base shadow-xs"
					style="background-color: {brandColor};"
				>
					{storeName.slice(0, 2).toUpperCase()}
				</div>
				<div>
					<h1 class="text-sm font-semibold text-slate-900 leading-tight">{storeName}</h1>
					<p class="text-xs text-slate-500 flex items-center gap-1">
						<span>Secure Checkout</span>
						<span class="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
					</p>
				</div>
			</div>

			{#if session}
				<div class="text-right">
					<div class="text-lg font-bold text-slate-900 leading-tight">
						৳{session.amount.toLocaleString('en-BD')}
					</div>
					{#if session.external_order_id}
						<div class="text-xs font-mono text-slate-500">{session.external_order_id}</div>
					{/if}
				</div>
			{/if}
		</div>
	</header>

	<!-- Main Checkout Container -->
	<main class="w-full max-w-md mx-auto p-4 sm:p-6 flex-1 flex flex-col justify-center">
		{#if loadError || !session}
			<!-- Error State -->
			<div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 text-center">
				<div class="w-14 h-14 bg-rose-50 text-rose-500 rounded-full flex items-center justify-center mx-auto mb-4 text-2xl">
					⚠️
				</div>
				<h2 class="text-lg font-semibold text-slate-900 mb-2">Unable to load checkout</h2>
				<p class="text-sm text-slate-600 mb-6">{loadError || 'This payment link is invalid or has expired.'}</p>
				<a
					href="/"
					class="inline-flex items-center justify-center px-5 py-2.5 rounded-xl font-medium text-sm text-white transition-opacity hover:opacity-90"
					style="background-color: {brandColor};"
				>
					Return Home
				</a>
			</div>
		{:else if session.status === 'PAID'}
			<!-- PAID State -->
			<div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 text-center">
				<div class="w-16 h-16 bg-emerald-50 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-4 text-3xl">
					✓
				</div>
				<h2 class="text-xl font-bold text-slate-900 mb-2">Payment Verified & Paid</h2>
				<p class="text-sm text-slate-600 mb-6">
					Your payment of <b>৳{session.amount.toLocaleString('en-BD')}</b> was verified successfully by the seller.
				</p>
				<a
					href={session.success_url}
					class="w-full inline-flex items-center justify-center py-3 px-4 rounded-xl font-medium text-white transition-opacity hover:opacity-95 shadow-xs"
					style="background-color: {brandColor};"
				>
					Return to Store Receipts →
				</a>
			</div>
		{:else if session.status === 'CONFIRMED' && session.method === 'cod'}
			<!-- COD Confirmed Screen -->
			<div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 text-center">
				<div class="w-16 h-16 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-4 text-3xl">
					📦
				</div>
				<h2 class="text-xl font-bold text-slate-900 mb-2">Cash on Delivery Confirmed</h2>
				<p class="text-sm text-slate-600 mb-6">
					Your order is confirmed. Please pay <b>৳{session.amount.toLocaleString('en-BD')}</b> in cash when delivered by courier.
				</p>
				{#if submittedRedirectUrl}
					<p class="text-xs text-slate-400 mb-4">Redirecting in {redirectCountdown}s...</p>
				{/if}
				<a
					href={submittedRedirectUrl || session.success_url}
					class="w-full inline-flex items-center justify-center py-3 px-4 rounded-xl font-medium text-white transition-opacity hover:opacity-95 shadow-xs"
					style="background-color: {brandColor};"
				>
					Continue to Store →
				</a>
			</div>
		{:else if session.status === 'SUBMITTED'}
			<!-- Optimistic Thank-You Screen (Async Verification) -->
			<div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 text-center">
				<div class="w-16 h-16 bg-emerald-50 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-4 text-3xl animate-bounce">
					✓
				</div>
				<h2 class="text-xl font-bold text-slate-900 mb-2">Payment Details Received!</h2>
				<p class="text-sm text-slate-600 leading-relaxed mb-6">
					Thank you! The seller will verify your payment details shortly in their mobile banking app. Verification usually takes a few minutes to a few hours.
				</p>

				<div class="bg-slate-50 border border-slate-100 rounded-xl p-4 text-left text-xs space-y-2 mb-6">
					<div class="flex justify-between">
						<span class="text-slate-500">Method:</span>
						<span class="font-semibold text-slate-800 uppercase">{session.method} Send Money</span>
					</div>
					<div class="flex justify-between">
						<span class="text-slate-500">Amount:</span>
						<span class="font-semibold text-slate-800">৳{session.amount.toLocaleString('en-BD')}</span>
					</div>
					{#if session.trx_id}
						<div class="flex justify-between">
							<span class="text-slate-500">{trxLabel}:</span>
							<span class="font-mono font-bold text-slate-900">{session.trx_id}</span>
						</div>
					{/if}
					{#if session.sender_number}
						<div class="flex justify-between">
							<span class="text-slate-500">From Account:</span>
							<span class="font-mono text-slate-800">{session.sender_number}</span>
						</div>
					{/if}
				</div>

				{#if submittedRedirectUrl}
					<p class="text-xs text-slate-400 mb-4">
						Redirecting back to shop in <span class="font-bold text-slate-700">{redirectCountdown}s</span>...
					</p>
				{/if}

				<a
					href={submittedRedirectUrl || session.success_url}
					class="w-full inline-flex items-center justify-center py-3.5 px-4 rounded-xl font-medium text-white transition-opacity hover:opacity-95 shadow-xs"
					style="background-color: {brandColor};"
				>
					Return to Shop Now →
				</a>
			</div>
		{:else if session.status === 'CANCELLED'}
			<!-- CANCELLED State -->
			<div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 text-center">
				<div class="w-14 h-14 bg-slate-100 text-slate-500 rounded-full flex items-center justify-center mx-auto mb-4 text-2xl">
					🚫
				</div>
				<h2 class="text-xl font-bold text-slate-900 mb-2">Payment Cancelled</h2>
				<p class="text-sm text-slate-600 mb-6">This payment session has been cancelled.</p>
				{#if session.cancel_url || session.success_url}
					<a
						href={session.cancel_url || session.success_url}
						class="inline-flex items-center justify-center px-6 py-2.5 rounded-xl font-medium text-sm text-white"
						style="background-color: {brandColor};"
					>
						Return to Store
					</a>
				{/if}
			</div>
		{:else}
			<!-- Active Payment Flow (CREATED / REJECTED / Late EXPIRED) -->
			<div class="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
				<!-- Rejection Notice (if session is REJECTED) -->
				{#if session.status === 'REJECTED'}
					<div class="bg-amber-50 border-b border-amber-200 p-4 text-xs text-amber-800">
						<p class="font-semibold mb-1">⚠️ Payment details could not be verified</p>
						<p>Please double-check your mobile banking app transaction history and resubmit with the correct {trxLabel}.</p>
						{#if session.attempts_remaining !== undefined}
							<p class="mt-1 font-bold">Attempts remaining: {session.attempts_remaining} of 3</p>
						{/if}
					</div>
				{/if}

				<!-- Late Submission Grace Period Banner -->
				{#if session.can_late_submit}
					<div class="bg-amber-50 border-b border-amber-200 p-3 text-xs text-amber-900 flex items-center gap-2">
						<span>⏰</span>
						<span>This session expired, but late submission is currently active.</span>
					</div>
				{/if}

				<!-- Step 1: Payment Method Selection -->
				{#if !selectedMethod}
					<div class="p-6">
						<h2 class="text-base font-bold text-slate-900 mb-1">Choose Payment Method</h2>
						<p class="text-xs text-slate-500 mb-5">Select your preferred payment method to proceed.</p>

						<div class="space-y-3">
							<!-- bKash Button -->
							<button
								type="button"
								disabled={!bkashEnabled || isSubmitting}
								onclick={() => handleSelectMethod('bkash')}
								class="w-full flex items-center justify-between p-4 rounded-xl border border-slate-200 hover:border-[#E2136E] hover:bg-pink-50/20 transition-colors text-left disabled:opacity-40 disabled:pointer-events-none"
							>
								<div class="flex items-center gap-3">
									<div class="w-10 h-10 rounded-lg bg-[#E2136E] text-white flex items-center justify-center font-bold text-xs shadow-xs">
										bKash
									</div>
									<div>
										<div class="font-semibold text-sm text-slate-900">bKash Send Money</div>
										<div class="text-xs text-slate-500">Personal Account Transfer</div>
									</div>
								</div>
								<span class="text-slate-400 text-lg">›</span>
							</button>

							<!-- Nagad Button -->
							<button
								type="button"
								disabled={!nagadEnabled || isSubmitting}
								onclick={() => handleSelectMethod('nagad')}
								class="w-full flex items-center justify-between p-4 rounded-xl border border-slate-200 hover:border-[#F7941D] hover:bg-orange-50/20 transition-colors text-left disabled:opacity-40 disabled:pointer-events-none"
							>
								<div class="flex items-center gap-3">
									<div class="w-10 h-10 rounded-lg bg-[#F7941D] text-white flex items-center justify-center font-bold text-xs shadow-xs">
										Nagad
									</div>
									<div>
										<div class="font-semibold text-sm text-slate-900">Nagad Send Money</div>
										<div class="text-xs text-slate-500">Personal Account Transfer</div>
									</div>
								</div>
								<span class="text-slate-400 text-lg">›</span>
							</button>

							<!-- COD Button -->
							<button
								type="button"
								disabled={!codEnabled || isSubmitting}
								onclick={() => handleSelectMethod('cod')}
								class="w-full flex items-center justify-between p-4 rounded-xl border border-slate-200 hover:border-slate-400 hover:bg-slate-50 transition-colors text-left disabled:opacity-40 disabled:pointer-events-none"
							>
								<div class="flex items-center gap-3">
									<div class="w-10 h-10 rounded-lg bg-slate-800 text-white flex items-center justify-center text-lg shadow-xs">
										📦
									</div>
									<div>
										<div class="font-semibold text-sm text-slate-900">Cash on Delivery (COD)</div>
										<div class="text-xs text-slate-500">Pay cash upon parcel delivery</div>
									</div>
								</div>
								<span class="text-slate-400 text-lg">›</span>
							</button>
						</div>

						{#if errorMessage}
							<div class="mt-4 p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-700">
								{errorMessage}
							</div>
						{/if}
					</div>
				{:else}
					<!-- Step 2: bKash / Nagad Send Money Submission Form -->
					<div class="p-6">
						{#if session.status === 'CREATED'}
							<button
								type="button"
								onclick={() => { selectedMethod = null; errorMessage = null; }}
								class="text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1 mb-4"
							>
								<span>‹</span> Change payment method
							</button>
						{/if}

						<div class="flex items-center justify-between mb-4">
							<span class="text-xs font-semibold uppercase tracking-wider text-slate-500">
								{selectedMethod} Send Money
							</span>
							<span
								class="px-2 py-0.5 rounded text-[10px] font-bold text-white uppercase"
								style="background-color: {isBkash ? '#E2136E' : '#F7941D'};"
							>
								{selectedMethod}
							</span>
						</div>

						<!-- Assigned Wallet & Amount Cards with 1-Click Copy -->
						<div class="space-y-3 mb-6">
							<!-- Wallet Number Box -->
							<div class="p-3.5 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between">
								<div>
									<div class="text-[11px] font-medium text-slate-500">Send Money to this personal number:</div>
									<div class="text-base font-mono font-bold text-slate-900">
										{session.assigned_wallet?.number || 'Assigning...'}
									</div>
								</div>
								{#if session.assigned_wallet?.number}
									<button
										type="button"
										onclick={() => copyToClipboard(session?.assigned_wallet?.number || '', 'number')}
										class="px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-300 bg-white hover:bg-slate-50 transition-colors shadow-2xs"
									>
										{copiedField === 'number' ? 'Copied! ✓' : 'Copy'}
									</button>
								{/if}
							</div>

							<!-- Payable Amount Box -->
							<div class="p-3.5 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between">
								<div>
									<div class="text-[11px] font-medium text-slate-500">Exact Payable Amount:</div>
									<div class="text-base font-bold text-slate-900">
										৳{session.amount.toLocaleString('en-BD')}
									</div>
								</div>
								<button
									type="button"
									onclick={() => copyToClipboard(String(session?.amount || ''), 'amount')}
									class="px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-300 bg-white hover:bg-slate-50 transition-colors shadow-2xs"
								>
									{copiedField === 'amount' ? 'Copied! ✓' : 'Copy'}
								</button>
							</div>
						</div>

						<!-- Step-by-Step Instructions -->
						<div class="bg-blue-50/50 border border-blue-100 rounded-xl p-3.5 text-xs text-slate-600 space-y-1.5 mb-6">
							<div class="font-semibold text-slate-900">Instructions:</div>
							<div class="flex gap-2">
								<span class="font-bold text-blue-600">1.</span>
								<span>Open your <b>{isBkash ? 'bKash' : 'Nagad'}</b> app and tap <b>Send Money</b>.</span>
							</div>
							<div class="flex gap-2">
								<span class="font-bold text-blue-600">2.</span>
								<span>Send <b>৳{session.amount.toLocaleString('en-BD')}</b> to the account number copied above.</span>
							</div>
							<div class="flex gap-2">
								<span class="font-bold text-blue-600">3.</span>
								<span>Copy the <b>{trxLabel}</b> from the receipt and submit below.</span>
							</div>
						</div>

						<!-- Submission Form -->
						<form onsubmit={handleSubmit} class="space-y-4">
							<!-- Hidden Honeypot for Anti-Bot Protection -->
							<input
								type="text"
								name="website_url"
								tabindex="-1"
								autocomplete="off"
								bind:value={honeypot}
								class="hidden"
								aria-hidden="true"
							/>

							<!-- Sender Phone Number -->
							<div>
								<label for="sender_number" class="block text-xs font-semibold text-slate-700 mb-1">
									Your {isBkash ? 'bKash' : 'Nagad'} Mobile Number
								</label>
								<input
									id="sender_number"
									type="tel"
									required
									placeholder="01XXXXXXXXX"
									maxlength="11"
									bind:value={senderNumber}
									class="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 focus:outline-hidden focus:ring-2 focus:ring-slate-400 font-mono text-sm placeholder:text-slate-400"
								/>
							</div>

							<!-- TrxID / TxnID -->
							<div>
								<label for="trx_id" class="block text-xs font-semibold text-slate-700 mb-1">
									Transaction ID ({trxLabel})
								</label>
								<input
									id="trx_id"
									type="text"
									required
									placeholder="e.g. 9K3L2M1ABC"
									bind:value={trxId}
									oninput={() => { trxId = trxId.toUpperCase(); }}
									class="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 focus:outline-hidden focus:ring-2 focus:ring-slate-400 font-mono text-sm uppercase placeholder:text-slate-400"
								/>
							</div>

							{#if errorMessage}
								<div class="p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-700">
									{errorMessage}
								</div>
							{/if}

							<!-- Submit Button -->
							<button
								type="submit"
								disabled={isSubmitting || (session.attempts >= 3)}
								class="w-full py-3.5 px-4 rounded-xl font-medium text-sm text-white shadow-xs transition-opacity hover:opacity-95 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
								style="background-color: {brandColor};"
							>
								{#if isSubmitting}
									<span class="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
									<span>Submitting...</span>
								{:else}
									<span>Confirm & Submit Details</span>
								{/if}
							</button>
						</form>
					</div>
				{/if}
			</div>
		{/if}
	</main>

	<!-- Minimal Footer -->
	<footer class="w-full max-w-md mx-auto text-center px-4">
		<p class="text-[11px] text-slate-400">
			Powered by <a href="https://github.com" target="_blank" rel="noopener noreferrer" class="hover:underline font-semibold text-slate-500">SMPG</a> · Send Money Payment Gateway
		</p>
	</footer>
</div>
