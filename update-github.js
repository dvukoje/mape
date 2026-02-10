window.glide = async function(configString) {
  if (!configString) return "No config";

  // Unpack: Data, Token, Owner, Repo, UserID
  const [jsonData, githubToken, repoOwner, repoName, userId] = configString.split('|');
  
  // Create a unique path for each user
  const filePath = `data/users/${userId}.json`; 
  const url = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${filePath}`;

  try {
    const getFile = await fetch(url, {
      headers: { "Authorization": `Bearer ${githubToken}` }
    });
    
    let sha = "";
    if (getFile.ok) {
      const fileData = await getFile.json();
      sha = fileData.sha;
    }

    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${githubToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: `Update data for ${userId}`,
        content: btoa(unescape(encodeURIComponent(jsonData))),
        sha: sha
      })
    });

    return response.ok ? "Synced" : "Error";
  } catch (e) {
    return "Failed";
  }
};
