const handleLogin = async (provider: string) => {
  try {
    loading.value = true
    error.value = ''
    if (provider === 'google') {
      // Redirect to backend auth endpoint
      window.location.href = `${import.meta.env.VITE_API_URL}/auth/google`
    } else if (provider === 'email') {
      // Handle email login
      await authStore.login(provider)
    }
  } catch (err) {
    error.value = 'Failed to sign in. Please try again.'
    console.error('Login error:', err)
  } finally {
    loading.value = false
  }
}

// Remove the OAuth callback handling since it's handled by the backend redirect
onMounted(() => {
  const searchParams = new URLSearchParams(window.location.search)
  const token = searchParams.get('token')
  
  if (token) {
    authStore.setToken(token)
    router.push('/')
  }
}) 