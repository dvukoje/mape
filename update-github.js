window.glide = async function(configString) {
  if (!configString) return "No config provided";

  // Unpack the parameters
  const [jsonData, githubToken, repoOwner, repoName] = configString.split('|');
  const filePath = "data.json";
  const url = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${filePath}`;

  try {
    // 1. Fetch existing SHA
    const getFile = await fetch(url, {
      headers: { "Authorization": `Bearer ${githubToken}` }
    });
    
    let sha = "";
    if (getFile.ok) {
      const fileData = await getFile.json();
      sha = fileData.sha;
    }

    // 2. Push updated data
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${githubToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "Update via Glide JS Column",
        content: btoa(unescape(encodeURIComponent(jsonData))), // Safe Base64 encoding
        sha: sha
      })
    });

    return response.ok ? `Updated: ${new Date().toLocaleTimeString()}` : "Error: " + response.status;
  } catch (e) {
    return "Failed: " + e.message;
  }
};
